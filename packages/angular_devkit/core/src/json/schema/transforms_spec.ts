/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { CoreSchemaRegistry } from './registry';
import { addUndefinedDefaults } from './transforms';

describe('addUndefinedDefaults', () => {
  it('should add defaults to undefined properties (1)', async () => {
    const registry = new CoreSchemaRegistry();
    registry.addPreTransform(addUndefinedDefaults);
    const data: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

    const validator = await registry.compile({
      properties: {
        bool: { type: 'boolean' },
        str: { type: 'string', default: 'someString' },
        obj: {
          properties: {
            num: { type: 'number' },
            other: { type: 'number', default: 0 },
          },
        },
        objAllOk: {
          allOf: [{ type: 'object' }],
        },
        objAllBad: {
          allOf: [{ type: 'object' }, { type: 'number' }],
        },
        objOne: {
          oneOf: [{ type: 'object' }],
        },
        objNotOk: {
          not: { not: { type: 'object' } },
        },
        objNotBad: {
          type: 'object',
          not: { type: 'object' },
        },
      },
    });

    const result = await validator(data);

    expect(result.success).toBeTrue();
    expect(data.bool).toBeUndefined();
    expect(data.str).toBe('someString');
    expect(data.obj.num).toBeUndefined();
    expect(data.obj.other).toBe(0);
    expect(data.objAllOk).toEqual({});
    expect(data.objOne).toEqual({});
    expect(data.objAllBad).toBeUndefined();
    expect(data.objNotOk).toEqual({});
    expect(data.objNotBad).toBeUndefined();
  });

  it('should add defaults to undefined properties (2)', async () => {
    const registry = new CoreSchemaRegistry();
    registry.addPreTransform(addUndefinedDefaults);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      bool: undefined,
      str: undefined,
      obj: {
        num: undefined,
      },
    };

    const validator = await registry.compile({
      properties: {
        bool: { type: 'boolean', default: true },
        str: { type: 'string', default: 'someString' },
        obj: {
          properties: {
            num: { type: 'number', default: 0 },
          },
        },
      },
    });

    const result = await validator(data);

    expect(result.success).toBeTrue();
    expect(data.bool).toBeTrue();
    expect(data.str).toBe('someString');
    expect(data.obj.num).toBe(0);
  });

  it('should add defaults to undefined properties when using oneOf', async () => {
    const registry = new CoreSchemaRegistry();
    registry.addPreTransform(addUndefinedDefaults);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataNoObj: any = {
      bool: undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataObj: any = {
      bool: undefined,
      obj: {
        a: false,
      },
    };

    const validator = await registry.compile({
      properties: {
        bool: { type: 'boolean', default: true },
        obj: {
          default: true,
          oneOf: [
            {
              type: 'object',
              properties: {
                a: { type: 'boolean', default: true },
                b: { type: 'boolean', default: true },
                c: { type: 'boolean', default: false },
              },
            },
            {
              type: 'boolean',
            },
          ],
        },
        noDefaultOneOf: {
          oneOf: [
            {
              type: 'object',
              properties: {
                a: { type: 'boolean', default: true },
                b: { type: 'boolean', default: true },
                c: { type: 'boolean', default: false },
              },
            },
            {
              type: 'boolean',
            },
          ],
        },
      },
    });

    const result1 = await validator(dataNoObj);
    expect(result1.success).toBeTrue();
    expect(dataNoObj.bool).toBeTrue();
    expect(dataNoObj.obj).toBeTrue();
    expect(dataNoObj.noDefaultOneOf).toBeUndefined();

    const result2 = await validator(dataObj);
    expect(result2.success).toBeTrue();
    expect(dataObj.bool).toBeTrue();
    expect(dataObj.obj.a).toBeFalse();
    expect(dataObj.obj.b).toBeTrue();
    expect(dataObj.obj.c).toBeFalse();
  });

  it('should add defaults to undefined properties when using anyOf', async () => {
    const registry = new CoreSchemaRegistry();
    registry.addPreTransform(addUndefinedDefaults);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataNoObj: any = {
      bool: undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataObj: any = {
      bool: undefined,
      obj: {
        a: false,
      },
    };

    const validator = await registry.compile({
      properties: {
        bool: { type: 'boolean', default: true },
        obj: {
          default: true,
          anyOf: [
            {
              type: 'object',
              properties: {
                d: { type: 'boolean', default: false },
              },
            },
            {
              type: 'object',
              properties: {
                a: { type: 'boolean', default: true },
                b: { type: 'boolean', default: true },
                c: { type: 'boolean', default: false },
              },
            },
            {
              type: 'boolean',
            },
          ],
        },
      },
    });

    const result1 = await validator(dataNoObj);
    expect(result1.success).toBeTrue();
    expect(dataNoObj.bool).toBeTrue();
    expect(dataNoObj.obj).toBeTrue();

    const result2 = await validator(dataObj);
    expect(result2.success).toBeTrue();
    expect(dataObj.bool).toBeTrue();
    expect(dataObj.obj.a).toBeFalse();
    expect(dataObj.obj.b).toBeTrue();
    expect(dataObj.obj.c).toBeFalse();
  });

  it('should add defaults to undefined properties when using $refs', async () => {
    const registry = new CoreSchemaRegistry();
    registry.addPreTransform(addUndefinedDefaults);
    const dataNoObj: Record<string, boolean> = {};

    const dataObj: Record<string, boolean> = {
      boolRef: true,
    };

    const validator = await registry.compile({
      definitions: {
        boolRef: {
          default: false,
          type: 'boolean',
        },
      },
      properties: {
        bool: {
          default: false,
          type: 'boolean',
        },
        boolRef: {
          $ref: '#/definitions/boolRef',
        },
      },
    });

    const result1 = await validator(dataNoObj);
    expect(result1.success).toBeTrue();
    expect(dataNoObj['bool']).toBeFalse();
    expect(dataNoObj['boolRef']).toBeFalse();

    const result2 = await validator(dataObj);
    expect(result2.success).toBeTrue();
    expect(dataObj['bool']).toBeFalse();
    expect(dataObj['boolRef']).toBeTrue();
  });
});
