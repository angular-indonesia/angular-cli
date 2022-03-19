/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { logging } from '@angular-devkit/core';
import yargs from 'yargs';
import { Parser } from 'yargs/helpers';
import { AddCommandModule } from '../commands/add/cli';
import { AnalyticsCommandModule } from '../commands/analytics/cli';
import { BuildCommandModule } from '../commands/build/cli';
import { CacheCommandModule } from '../commands/cache/cli';
import { ConfigCommandModule } from '../commands/config/cli';
import { DeployCommandModule } from '../commands/deploy/cli';
import { DocCommandModule } from '../commands/doc/cli';
import { E2eCommandModule } from '../commands/e2e/cli';
import { ExtractI18nCommandModule } from '../commands/extract-i18n/cli';
import { GenerateCommandModule } from '../commands/generate/cli';
import { LintCommandModule } from '../commands/lint/cli';
import { AwesomeCommandModule } from '../commands/make-this-awesome/cli';
import { NewCommandModule } from '../commands/new/cli';
import { RunCommandModule } from '../commands/run/cli';
import { ServeCommandModule } from '../commands/serve/cli';
import { TestCommandModule } from '../commands/test/cli';
import { UpdateCommandModule } from '../commands/update/cli';
import { VersionCommandModule } from '../commands/version/cli';
import { colors } from '../utilities/color';
import { AngularWorkspace } from '../utilities/config';
import { getPackageManager } from '../utilities/package-manager';
import { CommandContext, CommandModuleError, CommandScope } from './command-module';
import { addCommandModuleToYargs, demandCommandFailureMessage } from './utilities/command';
import { jsonHelpUsage } from './utilities/json-help';

const COMMANDS = [
  VersionCommandModule,
  DocCommandModule,
  AwesomeCommandModule,
  ConfigCommandModule,
  AnalyticsCommandModule,
  AddCommandModule,
  GenerateCommandModule,
  BuildCommandModule,
  E2eCommandModule,
  TestCommandModule,
  ServeCommandModule,
  ExtractI18nCommandModule,
  DeployCommandModule,
  LintCommandModule,
  NewCommandModule,
  UpdateCommandModule,
  RunCommandModule,
  CacheCommandModule,
].sort(); // Will be sorted by class name.

const yargsParser = Parser as unknown as typeof Parser.default;

export async function runCommand(
  args: string[],
  logger: logging.Logger,
  workspace: AngularWorkspace | undefined,
): Promise<number> {
  const {
    $0,
    _: positional,
    help = false,
    jsonHelp = false,
    ...rest
  } = yargsParser(args, { boolean: ['help', 'json-help'], alias: { 'collection': 'c' } });

  const context: CommandContext = {
    workspace,
    logger,
    currentDirectory: process.cwd(),
    root: workspace?.basePath ?? process.cwd(),
    packageManager: await getPackageManager(workspace?.basePath ?? process.cwd()),
    args: {
      positional: positional.map((v) => v.toString()),
      options: {
        help,
        jsonHelp,
        ...rest,
      },
    },
  };

  let localYargs = yargs(args);
  for (const CommandModule of COMMANDS) {
    if (!jsonHelp) {
      // Skip scope validation when running with '--json-help' since it's easier to generate the output for all commands this way.
      const scope = CommandModule.scope;
      if ((scope === CommandScope.In && !workspace) || (scope === CommandScope.Out && workspace)) {
        continue;
      }
    }

    localYargs = addCommandModuleToYargs(localYargs, CommandModule, context);
  }

  if (jsonHelp) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (localYargs as any).getInternalMethods().getUsageInstance().help = () => jsonHelpUsage();
  }

  await localYargs
    .scriptName('ng')
    // https://github.com/yargs/yargs/blob/main/docs/advanced.md#customizing-yargs-parser
    .parserConfiguration({
      'populate--': true,
      'unknown-options-as-args': false,
      'dot-notation': false,
      'boolean-negation': true,
      'strip-aliased': true,
      'strip-dashed': true,
      'camel-case-expansion': false,
    })
    .option('json-help', {
      describe: 'Show help in JSON format.',
      implies: ['help'],
      hidden: true,
      type: 'boolean',
    })
    .help('help', 'Shows a help message for this command in the console.')
    // A complete list of strings can be found: https://github.com/yargs/yargs/blob/main/locales/en.json
    .updateStrings({
      'Commands:': colors.cyan('Commands:'),
      'Options:': colors.cyan('Options:'),
      'Positionals:': colors.cyan('Arguments:'),
      'deprecated': colors.yellow('deprecated'),
      'deprecated: %s': colors.yellow('deprecated:') + ' %s',
      'Did you mean %s?': 'Unknown command. Did you mean %s?',
    })
    .demandCommand(1, demandCommandFailureMessage)
    .recommendCommands()
    .version(false)
    .showHelpOnFail(false)
    .strict()
    .fail((msg, err) => {
      throw msg
        ? // Validation failed example: `Unknown argument:`
          new CommandModuleError(msg)
        : // Unknown exception, re-throw.
          err;
    })
    .wrap(yargs.terminalWidth())
    .parseAsync();

  return process.exitCode ?? 0;
}
