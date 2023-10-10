/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { BuilderContext } from '@angular-devkit/architect';
import assert from 'node:assert';
import { SourceFileCache } from '../../tools/esbuild/angular/source-file-cache';
import {
  createBrowserCodeBundleOptions,
  createServerCodeBundleOptions,
} from '../../tools/esbuild/application-code-bundle';
import { generateBudgetStats } from '../../tools/esbuild/budget-stats';
import { BuildOutputFileType, BundlerContext } from '../../tools/esbuild/bundler-context';
import { ExecutionResult, RebuildState } from '../../tools/esbuild/bundler-execution-result';
import { checkCommonJSModules } from '../../tools/esbuild/commonjs-checker';
import { createGlobalScriptsBundleOptions } from '../../tools/esbuild/global-scripts';
import { createGlobalStylesBundleOptions } from '../../tools/esbuild/global-styles';
import { generateIndexHtml } from '../../tools/esbuild/index-html-generator';
import { extractLicenses } from '../../tools/esbuild/license-extractor';
import {
  calculateEstimatedTransferSizes,
  getSupportedNodeTargets,
  logBuildStats,
  logMessages,
  transformSupportedBrowsersToTargets,
} from '../../tools/esbuild/utils';
import { checkBudgets } from '../../utils/bundle-calculator';
import { copyAssets } from '../../utils/copy-assets';
import { maxWorkers } from '../../utils/environment-options';
import { prerenderPages } from '../../utils/server-rendering/prerender';
import { augmentAppWithServiceWorkerEsbuild } from '../../utils/service-worker';
import { getSupportedBrowsers } from '../../utils/supported-browsers';
import { inlineI18n, loadActiveTranslations } from './i18n';
import { NormalizedApplicationBuildOptions } from './options';

// eslint-disable-next-line max-lines-per-function
export async function executeBuild(
  options: NormalizedApplicationBuildOptions,
  context: BuilderContext,
  rebuildState?: RebuildState,
): Promise<ExecutionResult> {
  const startTime = process.hrtime.bigint();

  const {
    projectRoot,
    workspaceRoot,
    serviceWorker,
    optimizationOptions,
    serverEntryPoint,
    assets,
    indexHtmlOptions,
    cacheOptions,
    prerenderOptions,
    appShellOptions,
    ssrOptions,
    verbose,
  } = options;

  const browsers = getSupportedBrowsers(projectRoot, context.logger);
  const target = transformSupportedBrowsersToTargets(browsers);

  // Load active translations if inlining
  // TODO: Integrate into watch mode and only load changed translations
  if (options.i18nOptions.shouldInline) {
    await loadActiveTranslations(context, options.i18nOptions);
  }

  // Reuse rebuild state or create new bundle contexts for code and global stylesheets
  let bundlerContexts = rebuildState?.rebuildContexts;
  const codeBundleCache =
    rebuildState?.codeBundleCache ??
    new SourceFileCache(cacheOptions.enabled ? cacheOptions.path : undefined);
  if (bundlerContexts === undefined) {
    bundlerContexts = [];

    // Browser application code
    bundlerContexts.push(
      new BundlerContext(
        workspaceRoot,
        !!options.watch,
        createBrowserCodeBundleOptions(options, target, codeBundleCache),
      ),
    );

    // Global Stylesheets
    if (options.globalStyles.length > 0) {
      for (const initial of [true, false]) {
        const bundleOptions = createGlobalStylesBundleOptions(
          options,
          target,
          initial,
          codeBundleCache?.loadResultCache,
        );
        if (bundleOptions) {
          bundlerContexts.push(
            new BundlerContext(workspaceRoot, !!options.watch, bundleOptions, () => initial),
          );
        }
      }
    }

    // Global Scripts
    if (options.globalScripts.length > 0) {
      for (const initial of [true, false]) {
        const bundleOptions = createGlobalScriptsBundleOptions(options, initial);
        if (bundleOptions) {
          bundlerContexts.push(
            new BundlerContext(workspaceRoot, !!options.watch, bundleOptions, () => initial),
          );
        }
      }
    }

    // Server application code
    // Skip server build when non of the features are enabled.
    if (serverEntryPoint && (prerenderOptions || appShellOptions || ssrOptions)) {
      const nodeTargets = getSupportedNodeTargets();
      bundlerContexts.push(
        new BundlerContext(
          workspaceRoot,
          !!options.watch,
          createServerCodeBundleOptions(options, [...target, ...nodeTargets], codeBundleCache),
          () => false,
        ),
      );
    }
  }

  const bundlingResult = await BundlerContext.bundleAll(bundlerContexts);

  // Log all warnings and errors generated during bundling
  await logMessages(context, bundlingResult);

  const executionResult = new ExecutionResult(bundlerContexts, codeBundleCache);

  // Return if the bundling has errors
  if (bundlingResult.errors) {
    return executionResult;
  }

  const { metafile, initialFiles, outputFiles } = bundlingResult;

  executionResult.outputFiles.push(...outputFiles);

  // Check metafile for CommonJS module usage if optimizing scripts
  if (optimizationOptions.scripts) {
    const messages = checkCommonJSModules(metafile, options.allowedCommonJsDependencies);
    await logMessages(context, { warnings: messages });
  }

  /**
   * Index HTML content without CSS inlining to be used for server rendering (AppShell, SSG and SSR).
   *
   * NOTE: we don't perform critical CSS inlining as this will be done during server rendering.
   */
  let indexContentOutputNoCssInlining: string | undefined;

  // Generate index HTML file
  // If localization is enabled, index generation is handled in the inlining process.
  // NOTE: Localization with SSR is not currently supported.
  if (indexHtmlOptions && !options.i18nOptions.shouldInline) {
    const { content, contentWithoutCriticalCssInlined, errors, warnings } = await generateIndexHtml(
      initialFiles,
      executionResult.outputFiles,
      {
        ...options,
        optimizationOptions,
      },
      // Set lang attribute to the defined source locale if present
      options.i18nOptions.hasDefinedSourceLocale ? options.i18nOptions.sourceLocale : undefined,
    );

    indexContentOutputNoCssInlining = contentWithoutCriticalCssInlined;
    printWarningsAndErrorsToConsole(context, warnings, errors);

    executionResult.addOutputFile(indexHtmlOptions.output, content, BuildOutputFileType.Browser);

    if (ssrOptions) {
      executionResult.addOutputFile(
        'index.server.html',
        contentWithoutCriticalCssInlined,
        BuildOutputFileType.Server,
      );
    }
  }

  // Pre-render (SSG) and App-shell
  // If localization is enabled, prerendering is handled in the inlining process.
  if ((prerenderOptions || appShellOptions) && !options.i18nOptions.shouldInline) {
    assert(
      indexContentOutputNoCssInlining,
      'The "index" option is required when using the "ssg" or "appShell" options.',
    );

    const { output, warnings, errors } = await prerenderPages(
      workspaceRoot,
      appShellOptions,
      prerenderOptions,
      executionResult.outputFiles,
      indexContentOutputNoCssInlining,
      optimizationOptions.styles.inlineCritical,
      maxWorkers,
      verbose,
    );

    printWarningsAndErrorsToConsole(context, warnings, errors);

    for (const [path, content] of Object.entries(output)) {
      executionResult.addOutputFile(path, content, BuildOutputFileType.Browser);
    }
  }

  // Copy assets
  if (assets) {
    // The webpack copy assets helper is used with no base paths defined. This prevents the helper
    // from directly writing to disk. This should eventually be replaced with a more optimized helper.
    executionResult.addAssets(await copyAssets(assets, [], workspaceRoot));
  }

  // Extract and write licenses for used packages
  if (options.extractLicenses) {
    executionResult.addOutputFile(
      '3rdpartylicenses.txt',
      await extractLicenses(metafile, workspaceRoot),
      BuildOutputFileType.Root,
    );
  }

  // Augment the application with service worker support
  // If localization is enabled, service worker is handled in the inlining process.
  if (serviceWorker && !options.i18nOptions.shouldInline) {
    try {
      const serviceWorkerResult = await augmentAppWithServiceWorkerEsbuild(
        workspaceRoot,
        serviceWorker,
        options.baseHref || '/',
        executionResult.outputFiles,
        executionResult.assetFiles,
      );
      executionResult.addOutputFile(
        'ngsw.json',
        serviceWorkerResult.manifest,
        BuildOutputFileType.Browser,
      );
      executionResult.addAssets(serviceWorkerResult.assetFiles);
    } catch (error) {
      context.logger.error(error instanceof Error ? error.message : `${error}`);

      return executionResult;
    }
  }

  // Analyze files for bundle budget failures if present
  let budgetFailures;
  if (options.budgets) {
    const compatStats = generateBudgetStats(metafile, initialFiles);
    budgetFailures = [...checkBudgets(options.budgets, compatStats, true)];
    for (const { severity, message } of budgetFailures) {
      if (severity === 'error') {
        context.logger.error(message);
      } else {
        context.logger.warn(message);
      }
    }
  }

  // Calculate estimated transfer size if scripts are optimized
  let estimatedTransferSizes;
  if (optimizationOptions.scripts || optimizationOptions.styles.minify) {
    estimatedTransferSizes = await calculateEstimatedTransferSizes(executionResult.outputFiles);
  }

  logBuildStats(context, metafile, initialFiles, budgetFailures, estimatedTransferSizes);

  const buildTime = Number(process.hrtime.bigint() - startTime) / 10 ** 9;
  context.logger.info(`Application bundle generation complete. [${buildTime.toFixed(3)} seconds]`);

  // Perform i18n translation inlining if enabled
  if (options.i18nOptions.shouldInline) {
    const { errors, warnings } = await inlineI18n(options, executionResult, initialFiles);
    printWarningsAndErrorsToConsole(context, warnings, errors);
  }

  // Write metafile if stats option is enabled
  if (options.stats) {
    executionResult.addOutputFile(
      'stats.json',
      JSON.stringify(metafile, null, 2),
      BuildOutputFileType.Root,
    );
  }

  return executionResult;
}

function printWarningsAndErrorsToConsole(
  context: BuilderContext,
  warnings: string[],
  errors: string[],
): void {
  for (const error of errors) {
    context.logger.error(error);
  }
  for (const warning of warnings) {
    context.logger.warn(warning);
  }
}
