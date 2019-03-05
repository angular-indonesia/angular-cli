/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  Architect,
  BuilderOutput,
  ScheduleOptions,
  Target,
} from '@angular-devkit/architect/src/index2';
import { TestProjectHost } from '@angular-devkit/architect/testing';
import {
  Path,
  experimental,
  join,
  json,
  logging,
  normalize,
  schema,
  virtualFs,
} from '@angular-devkit/core';
import { WorkspaceNodeModulesArchitectHost } from '../../architect/node';
import { TestingArchitectHost } from '../../architect/testing/testing-architect-host';
import { BrowserBuilderOutput } from '../src/browser/index2';


const devkitRoot = normalize((global as any)._DevKitRoot); // tslint:disable-line:no-any
export const workspaceRoot = join(
  devkitRoot,
  'tests/angular_devkit/build_angular/hello-world-app/',
);
export const host = new TestProjectHost(workspaceRoot);
export const outputPath: Path = normalize('dist');

export const browserTargetSpec = { project: 'app', target: 'build' };
export const devServerTargetSpec = { project: 'app', target: 'serve' };
export const extractI18nTargetSpec = { project: 'app', target: 'extract-i18n' };
export const karmaTargetSpec = { project: 'app', target: 'test' };
export const tslintTargetSpec = { project: 'app', target: 'lint' };
export const protractorTargetSpec = { project: 'app-e2e', target: 'e2e' };


export async function createArchitect(workspaceRoot: string) {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);

  const workspace = await experimental.workspace.Workspace.fromPath(host, host.root(), registry);
  const architectHost = new TestingArchitectHost(
    workspaceRoot,
    workspaceRoot,
    new WorkspaceNodeModulesArchitectHost(workspace, workspaceRoot),
  );
  const architect = new Architect(architectHost, registry);

  return {
    workspace,
    architectHost,
    architect,
  };
}

export async function browserBuild(
  architect: Architect,
  host: virtualFs.Host,
  target: Target,
  overrides?: json.JsonObject,
  scheduleOptions?: ScheduleOptions,
): Promise<{ output: BuilderOutput; files: { [file: string]: string } }> {
  const run = await architect.scheduleTarget(target, overrides, scheduleOptions);
  const output = (await run.result) as BrowserBuilderOutput;
  expect(output.success).toBe(true);

  expect(output.outputPath).not.toBeUndefined();
  const outputPath = normalize(output.outputPath);

  const fileNames = await host.list(outputPath).toPromise();
  const files = fileNames.reduce((acc: { [name: string]: Promise<string> }, path) => {
    let cache: Promise<string> | null = null;
    Object.defineProperty(acc, path, {
      enumerable: true,
      get() {
        if (cache) {
          return cache;
        }
        if (!fileNames.includes(path)) {
          return Promise.reject('No file named ' + path);
        }

        cache = host
          .read(join(outputPath, path))
          .toPromise()
          .then(content => virtualFs.fileBufferToString(content));

        return cache;
      },
    });

    return acc;
  }, {});

  await run.stop();

  return {
    output,
    files,
  };
}

export const lazyModuleFiles: { [path: string]: string } = {
  'src/app/lazy/lazy-routing.module.ts': `
    import { NgModule } from '@angular/core';
    import { Routes, RouterModule } from '@angular/router';

    const routes: Routes = [];

    @NgModule({
      imports: [RouterModule.forChild(routes)],
      exports: [RouterModule]
    })
    export class LazyRoutingModule { }
  `,
  'src/app/lazy/lazy.module.ts': `
    import { NgModule } from '@angular/core';
    import { CommonModule } from '@angular/common';

    import { LazyRoutingModule } from './lazy-routing.module';

    @NgModule({
      imports: [
        CommonModule,
        LazyRoutingModule
      ],
      declarations: []
    })
    export class LazyModule { }
  `,
};

export const lazyModuleImport: { [path: string]: string } = {
  'src/app/app.module.ts': `
    import { BrowserModule } from '@angular/platform-browser';
    import { NgModule } from '@angular/core';
    import { HttpModule } from '@angular/http';

    import { AppComponent } from './app.component';
    import { RouterModule } from '@angular/router';

    @NgModule({
      declarations: [
        AppComponent
      ],
      imports: [
        BrowserModule,
        HttpModule,
        RouterModule.forRoot([
          { path: 'lazy', loadChildren: './lazy/lazy.module#LazyModule' }
        ])
      ],
      providers: [],
      bootstrap: [AppComponent]
    })
    export class AppModule { }
  `,
};
