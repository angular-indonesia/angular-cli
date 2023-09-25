/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import type {
  Metafile,
  OnStartResult,
  OutputFile,
  PartialMessage,
  Plugin,
  PluginBuild,
} from 'esbuild';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { maxWorkers } from '../../../utils/environment-options';
import { JavaScriptTransformer } from '../javascript-transformer';
import { LoadResultCache, MemoryLoadResultCache } from '../load-result-cache';
import {
  logCumulativeDurations,
  profileAsync,
  profileSync,
  resetCumulativeDurations,
} from '../profiling';
import { BundleStylesheetOptions, bundleComponentStylesheet } from '../stylesheets/bundle-options';
import { AngularHostOptions } from './angular-host';
import { AngularCompilation, AotCompilation, JitCompilation, NoopCompilation } from './compilation';
import { setupJitPluginCallbacks } from './jit-plugin-callbacks';

const USING_WINDOWS = platform() === 'win32';
const WINDOWS_SEP_REGEXP = new RegExp(`\\${path.win32.sep}`, 'g');

export class SourceFileCache extends Map<string, ts.SourceFile> {
  readonly modifiedFiles = new Set<string>();
  readonly babelFileCache = new Map<string, Uint8Array>();
  readonly typeScriptFileCache = new Map<string, string | Uint8Array>();
  readonly loadResultCache = new MemoryLoadResultCache();

  referencedFiles?: readonly string[];

  constructor(readonly persistentCachePath?: string) {
    super();
  }

  invalidate(files: Iterable<string>): void {
    this.modifiedFiles.clear();
    for (let file of files) {
      this.babelFileCache.delete(file);
      this.typeScriptFileCache.delete(pathToFileURL(file).href);
      this.loadResultCache.invalidate(file);

      // Normalize separators to allow matching TypeScript Host paths
      if (USING_WINDOWS) {
        file = file.replace(WINDOWS_SEP_REGEXP, path.posix.sep);
      }

      this.delete(file);
      this.modifiedFiles.add(file);
    }
  }
}

export interface CompilerPluginOptions {
  sourcemap: boolean;
  tsconfig: string;
  jit?: boolean;
  /** Skip TypeScript compilation setup. This is useful to re-use the TypeScript compilation from another plugin. */
  noopTypeScriptCompilation?: boolean;
  advancedOptimizations?: boolean;
  thirdPartySourcemaps?: boolean;
  fileReplacements?: Record<string, string>;
  sourceFileCache?: SourceFileCache;
  loadResultCache?: LoadResultCache;
}

// TODO: find a better way to unblock TS compilation of server bundles.
let TS_COMPILATION_READY: Promise<void> | undefined;

// eslint-disable-next-line max-lines-per-function
export function createCompilerPlugin(
  pluginOptions: CompilerPluginOptions,
  styleOptions: BundleStylesheetOptions & { inlineStyleLanguage: string },
): Plugin {
  let resolveCompilationReady: (() => void) | undefined;

  if (!pluginOptions.noopTypeScriptCompilation) {
    TS_COMPILATION_READY = new Promise<void>((resolve) => {
      resolveCompilationReady = resolve;
    });
  }

  return {
    name: 'angular-compiler',
    // eslint-disable-next-line max-lines-per-function
    async setup(build: PluginBuild): Promise<void> {
      let setupWarnings: PartialMessage[] | undefined = [];

      const preserveSymlinks = build.initialOptions.preserveSymlinks;
      let tsconfigPath = pluginOptions.tsconfig;
      if (!preserveSymlinks) {
        // Use the real path of the tsconfig if not preserving symlinks.
        // This ensures the TS source file paths are based on the real path of the configuration.
        try {
          tsconfigPath = await realpath(tsconfigPath);
        } catch {}
      }

      // Initialize a worker pool for JavaScript transformations
      const javascriptTransformer = new JavaScriptTransformer(pluginOptions, maxWorkers);

      // Setup defines based on the values used by the Angular compiler-cli
      build.initialOptions.define ??= {};
      build.initialOptions.define['ngI18nClosureMode'] ??= 'false';

      // The in-memory cache of TypeScript file outputs will be used during the build in `onLoad` callbacks for TS files.
      // A string value indicates direct TS/NG output and a Uint8Array indicates fully transformed code.
      const typeScriptFileCache =
        pluginOptions.sourceFileCache?.typeScriptFileCache ??
        new Map<string, string | Uint8Array>();

      // The stylesheet resources from component stylesheets that will be added to the build results output files
      let additionalOutputFiles: OutputFile[] = [];
      let additionalMetafiles: Metafile[];

      // Create new reusable compilation for the appropriate mode based on the `jit` plugin option
      const compilation: AngularCompilation = pluginOptions.noopTypeScriptCompilation
        ? new NoopCompilation()
        : pluginOptions.jit
        ? new JitCompilation()
        : new AotCompilation();

      // Determines if TypeScript should process JavaScript files based on tsconfig `allowJs` option
      let shouldTsIgnoreJs = true;

      build.onStart(async () => {
        const result: OnStartResult = {
          warnings: setupWarnings,
        };

        // Reset debug performance tracking
        resetCumulativeDurations();

        // Reset additional output files
        additionalOutputFiles = [];
        additionalMetafiles = [];

        // Create Angular compiler host options
        const hostOptions: AngularHostOptions = {
          fileReplacements: pluginOptions.fileReplacements,
          modifiedFiles: pluginOptions.sourceFileCache?.modifiedFiles,
          sourceFileCache: pluginOptions.sourceFileCache,
          async transformStylesheet(data, containingFile, stylesheetFile) {
            // Stylesheet file only exists for external stylesheets
            const filename = stylesheetFile ?? containingFile;

            const stylesheetResult = await bundleComponentStylesheet(
              styleOptions.inlineStyleLanguage,
              data,
              filename,
              !stylesheetFile,
              styleOptions,
              pluginOptions.loadResultCache,
            );

            const { contents, resourceFiles, errors, warnings } = stylesheetResult;
            if (errors) {
              (result.errors ??= []).push(...errors);
            }
            (result.warnings ??= []).push(...warnings);
            additionalOutputFiles.push(...resourceFiles);
            if (stylesheetResult.metafile) {
              additionalMetafiles.push(stylesheetResult.metafile);
            }

            return contents;
          },
          processWebWorker(workerFile, containingFile) {
            const fullWorkerPath = path.join(path.dirname(containingFile), workerFile);
            // The synchronous API must be used due to the TypeScript compilation currently being
            // fully synchronous and this process callback being called from within a TypeScript
            // transformer.
            const workerResult = build.esbuild.buildSync({
              platform: 'browser',
              write: false,
              bundle: true,
              metafile: true,
              format: 'esm',
              mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
              sourcemap: pluginOptions.sourcemap,
              entryNames: 'worker-[hash]',
              entryPoints: [fullWorkerPath],
              absWorkingDir: build.initialOptions.absWorkingDir,
              outdir: build.initialOptions.outdir,
              minifyIdentifiers: build.initialOptions.minifyIdentifiers,
              minifySyntax: build.initialOptions.minifySyntax,
              minifyWhitespace: build.initialOptions.minifyWhitespace,
              target: build.initialOptions.target,
            });

            if (workerResult.errors) {
              (result.errors ??= []).push(...workerResult.errors);
            }
            (result.warnings ??= []).push(...workerResult.warnings);
            additionalOutputFiles.push(...workerResult.outputFiles);
            if (workerResult.metafile) {
              additionalMetafiles.push(workerResult.metafile);
            }

            // Return bundled worker file entry name to be used in the built output
            return path.relative(
              build.initialOptions.outdir ?? '',
              workerResult.outputFiles[0].path,
            );
          },
        };

        // Initialize the Angular compilation for the current build.
        // In watch mode, previous build state will be reused.
        const {
          compilerOptions: { allowJs },
          referencedFiles,
        } = await compilation.initialize(tsconfigPath, hostOptions, (compilerOptions) => {
          if (
            compilerOptions.target === undefined ||
            compilerOptions.target < ts.ScriptTarget.ES2022
          ) {
            // If 'useDefineForClassFields' is already defined in the users project leave the value as is.
            // Otherwise fallback to false due to https://github.com/microsoft/TypeScript/issues/45995
            // which breaks the deprecated `@Effects` NGRX decorator and potentially other existing code as well.
            compilerOptions.target = ts.ScriptTarget.ES2022;
            compilerOptions.useDefineForClassFields ??= false;

            // Only add the warning on the initial build
            setupWarnings?.push({
              text:
                'TypeScript compiler options "target" and "useDefineForClassFields" are set to "ES2022" and ' +
                '"false" respectively by the Angular CLI.',
              location: { file: pluginOptions.tsconfig },
              notes: [
                {
                  text:
                    'To control ECMA version and features use the Browerslist configuration. ' +
                    'For more information, see https://angular.io/guide/build#configuring-browser-compatibility',
                },
              ],
            });
          }

          // Enable incremental compilation by default if caching is enabled
          if (pluginOptions.sourceFileCache?.persistentCachePath) {
            compilerOptions.incremental ??= true;
            // Set the build info file location to the configured cache directory
            compilerOptions.tsBuildInfoFile = path.join(
              pluginOptions.sourceFileCache?.persistentCachePath,
              '.tsbuildinfo',
            );
          } else {
            compilerOptions.incremental = false;
          }

          return {
            ...compilerOptions,
            noEmitOnError: false,
            inlineSources: pluginOptions.sourcemap,
            inlineSourceMap: pluginOptions.sourcemap,
            mapRoot: undefined,
            sourceRoot: undefined,
            preserveSymlinks,
          };
        });
        shouldTsIgnoreJs = !allowJs;

        if (compilation instanceof NoopCompilation) {
          await TS_COMPILATION_READY;

          return result;
        }

        const diagnostics = await compilation.diagnoseFiles();
        if (diagnostics.errors) {
          (result.errors ??= []).push(...diagnostics.errors);
        }
        if (diagnostics.warnings) {
          (result.warnings ??= []).push(...diagnostics.warnings);
        }

        // Update TypeScript file output cache for all affected files
        profileSync('NG_EMIT_TS', () => {
          for (const { filename, contents } of compilation.emitAffectedFiles()) {
            typeScriptFileCache.set(pathToFileURL(filename).href, contents);
          }
        });

        // Store referenced files for updated file watching if enabled
        if (pluginOptions.sourceFileCache) {
          pluginOptions.sourceFileCache.referencedFiles = referencedFiles;
        }

        // Reset the setup warnings so that they are only shown during the first build.
        setupWarnings = undefined;

        // TODO: find a better way to unblock TS compilation of server bundles.
        resolveCompilationReady?.();

        return result;
      });

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const request = pluginOptions.fileReplacements?.[args.path] ?? args.path;

        // Skip TS load attempt if JS TypeScript compilation not enabled and file is JS
        if (shouldTsIgnoreJs && /\.[cm]?js$/.test(request)) {
          return undefined;
        }

        // The filename is currently used as a cache key. Since the cache is memory only,
        // the options cannot change and do not need to be represented in the key. If the
        // cache is later stored to disk, then the options that affect transform output
        // would need to be added to the key as well as a check for any change of content.
        let contents = typeScriptFileCache.get(pathToFileURL(request).href);

        if (contents === undefined) {
          // No TS result indicates the file is not part of the TypeScript program.
          // If allowJs is enabled and the file is JS then defer to the next load hook.
          if (!shouldTsIgnoreJs && /\.[cm]?js$/.test(request)) {
            return undefined;
          }

          // Otherwise return an error
          return {
            errors: [
              createMissingFileError(request, args.path, build.initialOptions.absWorkingDir ?? ''),
            ],
          };
        } else if (typeof contents === 'string') {
          // A string indicates untransformed output from the TS/NG compiler
          contents = await javascriptTransformer.transformData(
            request,
            contents,
            true /* skipLinker */,
          );

          // Store as the returned Uint8Array to allow caching the fully transformed code
          typeScriptFileCache.set(pathToFileURL(request).href, contents);
        }

        return {
          contents,
          loader: 'js',
        };
      });

      build.onLoad({ filter: /\.[cm]?js$/ }, (args) =>
        profileAsync(
          'NG_EMIT_JS*',
          async () => {
            // The filename is currently used as a cache key. Since the cache is memory only,
            // the options cannot change and do not need to be represented in the key. If the
            // cache is later stored to disk, then the options that affect transform output
            // would need to be added to the key as well as a check for any change of content.
            let contents = pluginOptions.sourceFileCache?.babelFileCache.get(args.path);
            if (contents === undefined) {
              contents = await javascriptTransformer.transformFile(args.path, pluginOptions.jit);
              pluginOptions.sourceFileCache?.babelFileCache.set(args.path, contents);
            }

            return {
              contents,
              loader: 'js',
            };
          },
          true,
        ),
      );

      // Setup bundling of component templates and stylesheets when in JIT mode
      if (pluginOptions.jit) {
        setupJitPluginCallbacks(
          build,
          styleOptions,
          additionalOutputFiles,
          pluginOptions.loadResultCache,
        );
      }

      build.onEnd((result) => {
        // Add any additional output files to the main output files
        if (additionalOutputFiles.length) {
          result.outputFiles?.push(...additionalOutputFiles);
        }

        // Combine additional metafiles with main metafile
        if (result.metafile && additionalMetafiles.length) {
          for (const metafile of additionalMetafiles) {
            result.metafile.inputs = { ...result.metafile.inputs, ...metafile.inputs };
            result.metafile.outputs = { ...result.metafile.outputs, ...metafile.outputs };
          }
        }

        logCumulativeDurations();
      });
    },
  };
}

function createMissingFileError(request: string, original: string, root: string): PartialMessage {
  const error = {
    text: `File '${path.relative(root, request)}' is missing from the TypeScript compilation.`,
    notes: [
      {
        text: `Ensure the file is part of the TypeScript program via the 'files' or 'include' property.`,
      },
    ],
  };

  if (request !== original) {
    error.notes.push({
      text: `File is requested from a file replacement of '${path.relative(root, original)}'.`,
    });
  }

  return error;
}
