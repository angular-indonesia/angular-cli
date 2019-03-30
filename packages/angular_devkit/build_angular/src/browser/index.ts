/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  BuilderContext,
  BuilderInfo,
  BuilderOutput,
  createBuilder,
} from '@angular-devkit/architect/src/index2';
import {
  WebpackLoggingCallback,
  runWebpack,
} from '@angular-devkit/build-webpack/src/webpack/index2';
import {
  Path,
  analytics,
  experimental,
  getSystemPath,
  join,
  json,
  logging,
  normalize,
  resolve,
  schema,
  virtualFs,
} from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import * as fs from 'fs';
import { Observable, from, of } from 'rxjs';
import { concatMap, map, switchMap } from 'rxjs/operators';
import * as ts from 'typescript'; // tslint:disable-line:no-implicit-dependencies
import { NgBuildAnalyticsPlugin } from '../../plugins/webpack/analytics';
import { WebpackConfigOptions } from '../angular-cli-files/models/build-options';
import {
  getAotConfig,
  getBrowserConfig,
  getCommonConfig,
  getNonAotConfig,
  getStatsConfig,
  getStylesConfig,
} from '../angular-cli-files/models/webpack-configs';
import { readTsconfig } from '../angular-cli-files/utilities/read-tsconfig';
import { requireProjectModule } from '../angular-cli-files/utilities/require-project-module';
import { augmentAppWithServiceWorker } from '../angular-cli-files/utilities/service-worker';
import {
  statsErrorsToString,
  statsToString,
  statsWarningsToString,
} from '../angular-cli-files/utilities/stats';
import {
  NormalizedBrowserBuilderSchema,
  defaultProgress,
  deleteOutputDir,
  normalizeBrowserSchema,
} from '../utils';
import { Schema as BrowserBuilderSchema } from './schema';

import webpack = require('webpack');
const SpeedMeasurePlugin = require('speed-measure-webpack-plugin');
const webpackMerge = require('webpack-merge');


export type BrowserBuilderOutput = json.JsonObject & BuilderOutput & {
  outputPath: string;
};


export function createBrowserLoggingCallback(
  verbose: boolean,
  logger: logging.LoggerApi,
): WebpackLoggingCallback {
  return (stats, config) => {
    // config.stats contains our own stats settings, added during buildWebpackConfig().
    const json = stats.toJson(config.stats);
    if (verbose) {
      logger.info(stats.toString(config.stats));
    } else {
      logger.info(statsToString(json, config.stats));
    }

    if (stats.hasWarnings()) {
      logger.warn(statsWarningsToString(json, config.stats));
    }
    if (stats.hasErrors()) {
      logger.error(statsErrorsToString(json, config.stats));
    }
  };
}

export function buildWebpackConfig(
  root: Path,
  projectRoot: Path,
  options: NormalizedBrowserBuilderSchema,
  additionalOptions: {
    logger?: logging.LoggerApi,
    analytics?: analytics.Analytics,
    builderInfo?: BuilderInfo,
  } = {},
): webpack.Configuration {
  // Ensure Build Optimizer is only used with AOT.
  if (options.buildOptimizer && !options.aot) {
    throw new Error(`The 'buildOptimizer' option cannot be used without 'aot'.`);
  }

  let wco: WebpackConfigOptions<NormalizedBrowserBuilderSchema>;

  const tsConfigPath = getSystemPath(normalize(resolve(root, normalize(options.tsConfig))));
  const tsConfig = readTsconfig(tsConfigPath);

  const projectTs = requireProjectModule(getSystemPath(projectRoot), 'typescript') as typeof ts;

  const supportES2015 = tsConfig.options.target !== projectTs.ScriptTarget.ES3
    && tsConfig.options.target !== projectTs.ScriptTarget.ES5;

  const logger = additionalOptions.logger
    ? additionalOptions.logger.createChild('webpackConfigOptions')
    : new logging.NullLogger();

  wco = {
    root: getSystemPath(root),
    logger,
    projectRoot: getSystemPath(projectRoot),
    buildOptions: options,
    tsConfig,
    tsConfigPath,
    supportES2015,
  };

  wco.buildOptions.progress = defaultProgress(wco.buildOptions.progress);

  const webpackConfigs: {}[] = [
    getCommonConfig(wco),
    getBrowserConfig(wco),
    getStylesConfig(wco),
    getStatsConfig(wco),
  ];

  if (additionalOptions.analytics) {
    // If there's analytics, add our plugin. Otherwise no need to slow down the build.
    let category = 'build';
    if (additionalOptions.builderInfo) {
      // We already vetted that this is a "safe" package, otherwise the analytics would be noop.
      category = additionalOptions.builderInfo.builderName.split(':')[1];
    }
    // The category is the builder name if it's an angular builder.
    webpackConfigs.push({
      plugins: [
        new NgBuildAnalyticsPlugin(wco.projectRoot, additionalOptions.analytics, category),
      ],
    });
  }

  if (wco.buildOptions.main || wco.buildOptions.polyfills) {
    const typescriptConfigPartial = wco.buildOptions.aot
      ? getAotConfig(wco)
      : getNonAotConfig(wco);
    webpackConfigs.push(typescriptConfigPartial);
  }

  const webpackConfig = webpackMerge(webpackConfigs);

  if (options.profile || process.env['NG_BUILD_PROFILING']) {
    const smp = new SpeedMeasurePlugin({
      outputFormat: 'json',
      outputTarget: getSystemPath(join(root, 'speed-measure-plugin.json')),
    });

    return smp.wrap(webpackConfig);
  }

  return webpackConfig;
}


export async function buildBrowserWebpackConfigFromWorkspace(
  options: BrowserBuilderSchema,
  projectName: string,
  workspace: experimental.workspace.Workspace,
  host: virtualFs.Host<fs.Stats>,
  additionalOptions: {
    logger?: logging.LoggerApi,
    analytics?: analytics.Analytics,
    builderInfo?: BuilderInfo,
  } = {},
): Promise<webpack.Configuration> {
  // TODO: Use a better interface for workspace access.
  const projectRoot = resolve(workspace.root, normalize(workspace.getProject(projectName).root));
  const sourceRoot = workspace.getProject(projectName).sourceRoot;

  const normalizedOptions = normalizeBrowserSchema(
    host,
    workspace.root,
    projectRoot,
    sourceRoot ? resolve(workspace.root, normalize(sourceRoot)) : undefined,
    options,
  );

  return buildWebpackConfig(workspace.root, projectRoot, normalizedOptions, additionalOptions);
}


export async function buildBrowserWebpackConfigFromContext(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  host: virtualFs.Host<fs.Stats>,
): Promise<{ workspace: experimental.workspace.Workspace, config: webpack.Configuration }> {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);

  const workspace = await experimental.workspace.Workspace.fromPath(
    host,
    normalize(context.workspaceRoot),
    registry,
  );

  const projectName = context.target ? context.target.project : workspace.getDefaultProjectName();

  if (!projectName) {
    throw new Error('Must either have a target from the context or a default project.');
  }

  const config = await buildBrowserWebpackConfigFromWorkspace(
    options,
    projectName,
    workspace,
    host,
    {
      logger: context.logger,
      analytics: context.analytics,
      builderInfo: context.builder,
    },
  );

  return { workspace, config };
}


export type BrowserConfigTransformFn = (
  workspace: experimental.workspace.Workspace,
  config: webpack.Configuration,
) => Observable<webpack.Configuration>;

export function buildWebpackBrowser(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  transforms: {
    config?: BrowserConfigTransformFn,
    output?: (output: BrowserBuilderOutput) => Observable<BuilderOutput>,
    logging?: WebpackLoggingCallback,
  } = {},
) {
  const host = new NodeJsSyncHost();
  const root = normalize(context.workspaceRoot);

  const configFn = transforms.config;
  const outputFn = transforms.output;
  const loggingFn = transforms.logging
      || createBrowserLoggingCallback(!!options.verbose, context.logger);

  // This makes a host observable into a cold one. This is because we want to wait until
  // subscription before calling buildBrowserWebpackConfigFromContext, which can throw.
  return of(null).pipe(
    switchMap(() => from(buildBrowserWebpackConfigFromContext(options, context, host))),
    switchMap(({ workspace, config }) => {
      if (configFn) {
        return configFn(workspace, config).pipe(
          map(config => ({ workspace, config })),
        );
      } else {
        return of({ workspace, config });
      }
    }),
    switchMap(({workspace, config}) => {
      if (options.deleteOutputPath) {
        return deleteOutputDir(
          normalize(context.workspaceRoot),
          normalize(options.outputPath),
          host,
        ).pipe(map(() => ({ workspace, config })));
      } else {
        return of({ workspace, config });
      }
    }),
    switchMap(({ workspace, config }) => {
      const projectName = context.target
        ? context.target.project : workspace.getDefaultProjectName();

      if (!projectName) {
        throw new Error('Must either have a target from the context or a default project.');
      }

      const projectRoot = resolve(
        workspace.root,
        normalize(workspace.getProject(projectName).root),
      );

      return runWebpack(config, context, { logging: loggingFn }).pipe(
        concatMap(buildEvent => {
          if (buildEvent.success && !options.watch && options.serviceWorker) {
            return from(augmentAppWithServiceWorker(
              host,
              root,
              projectRoot,
              resolve(root, normalize(options.outputPath)),
              options.baseHref || '/',
              options.ngswConfigPath,
            ).then(() => ({ success: true }), () => ({ success: false })));
          } else {
            return of(buildEvent);
          }
        }),
        map(event => ({
          ...event,
          outputPath: config.output && config.output.path || '',
        } as BrowserBuilderOutput)),
        concatMap(output => outputFn ? outputFn(output) : of(output)),
      );
    }),
  );
}


export default createBuilder<json.JsonObject & BrowserBuilderSchema>(buildWebpackBrowser);
