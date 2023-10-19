/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import type ng from '@angular/compiler-cli';
import type { PartialMessage } from 'esbuild';
import ts from 'typescript';
import { loadEsmModule } from '../../../../utils/load-esm';
import { profileAsync, profileSync } from '../../profiling';
import type { AngularHostOptions } from '../angular-host';
import { convertTypeScriptDiagnostic } from '../diagnostics';

export interface EmitFileResult {
  filename: string;
  contents: string;
  dependencies?: readonly string[];
}

export abstract class AngularCompilation {
  static #angularCompilerCliModule?: typeof ng;

  static async loadCompilerCli(): Promise<typeof ng> {
    // This uses a wrapped dynamic import to load `@angular/compiler-cli` which is ESM.
    // Once TypeScript provides support for retaining dynamic imports this workaround can be dropped.
    AngularCompilation.#angularCompilerCliModule ??=
      await loadEsmModule<typeof ng>('@angular/compiler-cli');

    return AngularCompilation.#angularCompilerCliModule;
  }

  protected async loadConfiguration(tsconfig: string): Promise<ng.CompilerOptions> {
    const { readConfiguration } = await AngularCompilation.loadCompilerCli();

    return profileSync('NG_READ_CONFIG', () =>
      readConfiguration(tsconfig, {
        // Angular specific configuration defaults and overrides to ensure a functioning compilation.
        suppressOutputPathCheck: true,
        outDir: undefined,
        sourceMap: false,
        declaration: false,
        declarationMap: false,
        allowEmptyCodegenFiles: false,
        annotationsAs: 'decorators',
        enableResourceInlining: false,
        supportTestBed: false,
        supportJitMode: false,
      }),
    );
  }

  abstract initialize(
    tsconfig: string,
    hostOptions: AngularHostOptions,
    compilerOptionsTransformer?: (compilerOptions: ng.CompilerOptions) => ng.CompilerOptions,
  ): Promise<{
    affectedFiles: ReadonlySet<ts.SourceFile>;
    compilerOptions: ng.CompilerOptions;
    referencedFiles: readonly string[];
  }>;

  abstract emitAffectedFiles(): Iterable<EmitFileResult> | Promise<Iterable<EmitFileResult>>;

  protected abstract collectDiagnostics():
    | Iterable<ts.Diagnostic>
    | Promise<Iterable<ts.Diagnostic>>;

  async diagnoseFiles(): Promise<{ errors?: PartialMessage[]; warnings?: PartialMessage[] }> {
    const result: { errors?: PartialMessage[]; warnings?: PartialMessage[] } = {};

    await profileAsync('NG_DIAGNOSTICS_TOTAL', async () => {
      for (const diagnostic of await this.collectDiagnostics()) {
        const message = convertTypeScriptDiagnostic(diagnostic);
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          (result.errors ??= []).push(message);
        } else {
          (result.warnings ??= []).push(message);
        }
      }
    });

    return result;
  }

  update?(files: Set<string>): Promise<void>;

  close?(): Promise<void>;
}
