/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { JsonValue } from '@angular-devkit/core';
import { lastValueFrom } from 'rxjs';
import { JobHandler } from './api';
import { createJobHandler } from './create-job-handler';
import { createDispatcher } from './dispatcher';
import { SimpleJobRegistry } from './simple-registry';
import { SimpleScheduler } from './simple-scheduler';

describe('createDispatcher', () => {
  it('works', async () => {
    const registry = new SimpleJobRegistry();
    const scheduler = new SimpleScheduler(registry);

    const dispatcher = createDispatcher({
      name: 'add',
      argument: { items: { type: 'number' } },
      output: { type: 'number' },
    });
    const add0 = createJobHandler((input: number[]) => input.reduce((a, c) => a + c, 0), {
      name: 'add0',
    });
    const add100 = createJobHandler((input: number[]) => input.reduce((a, c) => a + c, 100), {
      name: 'add100',
    });

    registry.register(dispatcher);
    registry.register(add0);
    registry.register(add100);

    dispatcher.setDefaultJob(add0 as JobHandler<JsonValue, JsonValue, number>);
    const sum = scheduler.schedule('add', [1, 2, 3, 4]);
    expect(await lastValueFrom(sum.output)).toBe(10);
  });
});
