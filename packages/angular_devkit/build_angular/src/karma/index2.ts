/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect/src/index2';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import { resolve } from 'path';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import * as webpack from 'webpack';
import {
  getCommonConfig,
  getNonAotConfig,
  getStylesConfig,
  getTestConfig,
} from '../angular-cli-files/models/webpack-configs';
import { Schema as BrowserBuilderOptions } from '../browser/schema';
import { generateBrowserWebpackConfigFromContext } from '../utils/webpack-browser-config';
import { Schema as KarmaBuilderOptions } from './schema';

// tslint:disable-next-line:no-implicit-dependencies
type KarmaConfigOptions = import ('karma').ConfigOptions & {
  buildWebpack?: unknown;
  configFile?: string;
};

async function initialize(
  options: KarmaBuilderOptions,
  context: BuilderContext,
  // tslint:disable-next-line:no-implicit-dependencies
): Promise<[typeof import ('karma'), webpack.Configuration]> {
  const host = new NodeJsSyncHost();
  const { config } = await generateBrowserWebpackConfigFromContext(
    // only two properties are missing:
    // * `outputPath` which is fixed for tests
    // * `index` which is not used for tests
    { ...options as unknown as BrowserBuilderOptions, outputPath: '' },
    context,
    wco => [
      getCommonConfig(wco),
      getStylesConfig(wco),
      getNonAotConfig(wco),
      getTestConfig(wco),
    ],
    host,
  );

  // tslint:disable-next-line:no-implicit-dependencies
  const karma = await import('karma');

  return [karma, config];
}

export function runKarma(
  options: KarmaBuilderOptions,
  context: BuilderContext,
): Observable<BuilderOutput> {
  const root = context.workspaceRoot;

  return from(initialize(options, context)).pipe(
    switchMap(([karma, webpackConfig]) => new Observable<BuilderOutput>(subscriber => {
      const karmaOptions: KarmaConfigOptions = {};

      if (options.watch !== undefined) {
        karmaOptions.singleRun = !options.watch;
      }

      // Convert browsers from a string to an array
      if (options.browsers) {
        karmaOptions.browsers = options.browsers.split(',');
      }

      if (options.reporters) {
        // Split along commas to make it more natural, and remove empty strings.
        const reporters = options.reporters
          .reduce<string[]>((acc, curr) => acc.concat(curr.split(/,/)), [])
          .filter(x => !!x);

        if (reporters.length > 0) {
          karmaOptions.reporters = reporters;
        }
      }

      // Assign additional karmaConfig options to the local ngapp config
      karmaOptions.configFile = resolve(root, options.karmaConfig);

      karmaOptions.buildWebpack = {
        options,
        webpackConfig,
        // Pass onto Karma to emit BuildEvents.
        successCb: () => subscriber.next({ success: true }),
        failureCb: () => subscriber.next({ success: false }),
        // Workaround for https://github.com/karma-runner/karma/issues/3154
        // When this workaround is removed, user projects need to be updated to use a Karma
        // version that has a fix for this issue.
        toJSON: () => { },
        logger: context.logger,
      };

      // Complete the observable once the Karma server returns.
      const karmaServer = new karma.Server(karmaOptions, () => subscriber.complete());
      // karma typings incorrectly define start's return value as void
      // tslint:disable-next-line:no-use-of-empty-return-value
      const karmaStart = karmaServer.start() as unknown as Promise<void>;

      // Cleanup, signal Karma to exit.
      return () => {
        // Karma only has the `stop` method start with 3.1.1, so we must defensively check.
        const karmaServerWithStop = karmaServer as unknown as { stop: () => Promise<void> };
        if (typeof karmaServerWithStop.stop === 'function') {
          return karmaStart.then(() => karmaServerWithStop.stop());
        }
      };
    })),
  );
}

export default createBuilder<Record<string, string> & KarmaBuilderOptions>(runKarma);
