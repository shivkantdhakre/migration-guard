import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TransformationEngine, resolveDestinationKey } from '../dist/transforms/engine.js';
import type { ObjectMapping } from '../src/types/index.js';

describe('Deterministic Transformation Engine (All 13 Allowlisted Transforms)', () => {
  // 1. RENAME
  it('RENAME: should rename source field to destination path', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'users' },
      destination: { table: 'users' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'old_name', destinationPath: 'new_name', transform: { op: 'RENAME' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({ id: '1', old_name: 'Antigravity' });

    assert.equal(result.payload.new_name, 'Antigravity');
    assert.equal(result.payload.old_name, undefined);
  });

  // 2. TRIM_STRING
  it('TRIM_STRING: should trim strings with both, left, and right modes', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 's1', destinationPath: 's1', transform: { op: 'TRIM_STRING', mode: 'both' } },
        { sourcePath: 's2', destinationPath: 's2', transform: { op: 'TRIM_STRING', mode: 'left' } },
        { sourcePath: 's3', destinationPath: 's3', transform: { op: 'TRIM_STRING', mode: 'right' } },
        { sourcePath: 's_null', destinationPath: 's_null', transform: { op: 'TRIM_STRING' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      s1: '  hello world  ',
      s2: '  hello left  ',
      s3: '  hello right  ',
      s_null: null,
    });

    assert.equal(result.payload.s1, 'hello world');
    assert.equal(result.payload.s2, 'hello left  ');
    assert.equal(result.payload.s3, '  hello right');
    assert.equal(result.payload.s_null, null);
  });

  // 3. LOWERCASE & 4. UPPERCASE
  it('LOWERCASE and UPPERCASE: should convert case properly', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'email', destinationPath: 'email_lower', transform: { op: 'LOWERCASE' } },
        { sourcePath: 'country', destinationPath: 'country_upper', transform: { op: 'UPPERCASE' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      email: 'Alice@Example.COM',
      country: 'usa',
    });

    assert.equal(result.payload.email_lower, 'alice@example.com');
    assert.equal(result.payload.country_upper, 'USA');
  });

  // 5. PARSE_INTEGER
  it('PARSE_INTEGER: should parse string, integer, float, with radix and strict options', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'n1', destinationPath: 'n1', transform: { op: 'PARSE_INTEGER' } },
        { sourcePath: 'n2', destinationPath: 'n2', transform: { op: 'PARSE_INTEGER' } },
        { sourcePath: 'hex', destinationPath: 'hex', transform: { op: 'PARSE_INTEGER', radix: 16 } },
        { sourcePath: 'float_val', destinationPath: 'float_val', transform: { op: 'PARSE_INTEGER' } },
        { sourcePath: 'invalid', destinationPath: 'invalid', transform: { op: 'PARSE_INTEGER', fallback: 0 } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      n1: '12345',
      n2: '1,000,000',
      hex: 'FF',
      float_val: 45.67,
      invalid: 'not_a_number',
    });

    assert.equal(result.payload.n1, 12345);
    assert.equal(result.payload.n2, 1000000);
    assert.equal(result.payload.hex, 255);
    assert.equal(result.payload.float_val, 45);
    assert.equal(result.payload.invalid, 0);
  });

  it('PARSE_INTEGER: strict mode should throw on invalid integer string', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'num', destinationPath: 'num', transform: { op: 'PARSE_INTEGER', strict: true } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    assert.throws(() => {
      engine.transform({ id: '1', num: 'abc' });
    }, /PARSE_INTEGER: Failed to parse/);
  });

  // 6. PARSE_DECIMAL
  it('PARSE_DECIMAL: should parse decimal and format scale with rounding mode', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'price1', destinationPath: 'price1', transform: { op: 'PARSE_DECIMAL', scale: 2, roundingMode: 'HALF_UP' } },
        { sourcePath: 'price2', destinationPath: 'price2', transform: { op: 'PARSE_DECIMAL', scale: 2, roundingMode: 'FLOOR' } },
        { sourcePath: 'raw_dec', destinationPath: 'raw_dec', transform: { op: 'PARSE_DECIMAL' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      price1: 19.995,
      price2: 19.999,
      raw_dec: '123456789.987654321',
    });

    assert.equal(result.payload.price1, '20.00');
    assert.equal(result.payload.price2, '19.99');
    assert.equal(result.payload.raw_dec, '123456789.987654321');
  });

  // 7. PARSE_TIMESTAMP
  it('PARSE_TIMESTAMP: should handle ISO string, epoch milliseconds, epoch seconds, and BSON dates', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 't_iso', destinationPath: 't_iso', transform: { op: 'PARSE_TIMESTAMP' } },
        { sourcePath: 't_sec', destinationPath: 't_sec', transform: { op: 'PARSE_TIMESTAMP' } },
        { sourcePath: 't_ms', destinationPath: 't_ms', transform: { op: 'PARSE_TIMESTAMP', format: 'EPOCH_MS' } },
        { sourcePath: 't_epoch_sec', destinationPath: 't_epoch_sec', transform: { op: 'PARSE_TIMESTAMP', format: 'EPOCH_SEC' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      t_iso: '2026-11-19T10:00:00.000Z',
      t_sec: 1700000000, // 2023-11-14T22:13:20.000Z
      t_ms: '2026-11-19T10:00:00.000Z',
      t_epoch_sec: '2026-11-19T10:00:00.000Z',
    });

    assert.equal(result.payload.t_iso, '2026-11-19T10:00:00.000Z');
    assert.equal(result.payload.t_sec, new Date(1700000000 * 1000).toISOString());
    assert.equal(result.payload.t_ms, new Date('2026-11-19T10:00:00.000Z').getTime());
    assert.equal(result.payload.t_epoch_sec, Math.floor(new Date('2026-11-19T10:00:00.000Z').getTime() / 1000));
  });

  // 8. TO_JSONB
  it('TO_JSONB: should normalize complex nested structures for JSONB', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'meta', destinationPath: 'meta', transform: { op: 'TO_JSONB' } },
        { sourcePath: 'pretty_meta', destinationPath: 'pretty_meta', transform: { op: 'TO_JSONB', pretty: true } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      meta: {
        objectId: { toHexString: () => '507f1f77bcf86cd799439011' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        tags: ['a', 'b'],
      },
      pretty_meta: { key: 'val' },
    });

    assert.deepEqual(result.payload.meta, {
      objectId: '507f1f77bcf86cd799439011',
      createdAt: '2026-01-01T00:00:00.000Z',
      tags: ['a', 'b'],
    });
    assert.equal(typeof result.payload.pretty_meta, 'string');
    assert.ok((result.payload.pretty_meta as string).includes('\n'));
  });

  // 9. FLATTEN_OBJECT
  it('FLATTEN_OBJECT: should flatten nested objects using custom delimiter', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'address', destinationPath: 'address', transform: { op: 'FLATTEN_OBJECT', delimiter: '_' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      address: {
        street: '123 Main St',
        geo: { lat: 40.71, lng: -74.00 },
      },
    });

    assert.deepEqual(result.payload.address, {
      street: '123 Main St',
      geo_lat: 40.71,
      geo_lng: -74.00,
    });
  });

  // 10. ARRAY_TO_CHILD_ROWS
  it('ARRAY_TO_CHILD_ROWS: should generate separate child rows with parent foreign key', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'orders' },
      destination: { table: 'orders' },
      identity: { sourceKey: 'order_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'customer_name', destinationPath: 'customer_name' },
        {
          sourcePath: 'items',
          destinationPath: 'items',
          transform: {
            op: 'ARRAY_TO_CHILD_ROWS',
            childTable: 'order_items',
            parentKeyCol: 'order_id',
            itemKeyCol: 'item_id',
            preserveIndexCol: 'item_index',
          },
        },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      order_id: 'ord_100',
      customer_name: 'John Doe',
      items: [
        { sku: 'ITEM-1', qty: 2, price: 15.5 },
        { sku: 'ITEM-2', qty: 1, price: 99.0 },
      ],
    });

    assert.equal(result.payload.customer_name, 'John Doe');
    // Field itself is skipped on parent record
    assert.equal(result.payload.items, undefined);

    assert.ok(result.childRows);
    assert.equal(result.childRows.length, 2);
    assert.equal(result.childRows[0].destinationTable, 'order_items');
    assert.equal(result.childRows[0].parentKey, 'ord_100');
    assert.equal(result.childRows[0].payload.order_id, 'ord_100');
    assert.equal(result.childRows[0].payload.sku, 'ITEM-1');
    assert.equal(result.childRows[0].payload.item_index, 0);

    assert.equal(result.childRows[1].payload.order_id, 'ord_100');
    assert.equal(result.childRows[1].payload.sku, 'ITEM-2');
    assert.equal(result.childRows[1].payload.item_index, 1);
  });

  // 11. SET_DEFAULT
  it('SET_DEFAULT: should provide default value only when source is undefined or null', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'status', destinationPath: 'status', transform: { op: 'SET_DEFAULT', value: 'PENDING' } },
        { sourcePath: 'role', destinationPath: 'role', transform: { op: 'SET_DEFAULT', value: 'USER' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      status: null,
      role: 'ADMIN',
    });

    assert.equal(result.payload.status, 'PENDING');
    assert.equal(result.payload.role, 'ADMIN');
  });

  // 12. NULL_IF_EMPTY
  it('NULL_IF_EMPTY: should turn empty string, empty array, and empty object into null', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'str_empty', destinationPath: 'str_empty', transform: { op: 'NULL_IF_EMPTY' } },
        { sourcePath: 'str_val', destinationPath: 'str_val', transform: { op: 'NULL_IF_EMPTY' } },
        { sourcePath: 'arr_empty', destinationPath: 'arr_empty', transform: { op: 'NULL_IF_EMPTY', emptyArrays: true } },
        { sourcePath: 'obj_empty', destinationPath: 'obj_empty', transform: { op: 'NULL_IF_EMPTY', emptyObjects: true } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      id: '1',
      str_empty: '   ',
      str_val: 'valid',
      arr_empty: [],
      obj_empty: {},
    });

    assert.equal(result.payload.str_empty, null);
    assert.equal(result.payload.str_val, 'valid');
    assert.equal(result.payload.arr_empty, null);
    assert.equal(result.payload.obj_empty, null);
  });

  // 13. PRESERVE_SOURCE_ID
  it('PRESERVE_SOURCE_ID: should normalize MongoDB ObjectId and other keys to string/hex', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: '_id', destinationKey: 'source_id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: '_id', destinationPath: 'legacy_id', transform: { op: 'PRESERVE_SOURCE_ID', format: 'hex' } },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({
      _id: { toHexString: () => '507F1F77BCF86CD799439011' },
    });

    assert.equal(result.destinationKey, '507F1F77BCF86CD799439011');
    assert.equal(result.payload.source_id, '507F1F77BCF86CD799439011');
    assert.equal(result.payload.legacy_id, '507f1f77bcf86cd799439011');
  });

  // Pipeline chaining: [TRIM_STRING, LOWERCASE]
  it('Pipeline chaining: should apply multiple transformations in sequence', () => {
    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        {
          sourcePath: 'username',
          destinationPath: 'username',
          transform: [
            { op: 'TRIM_STRING' },
            { op: 'LOWERCASE' },
          ],
        },
      ],
    };
    const engine = new TransformationEngine(mapping);
    const result = engine.transform({ id: '1', username: '   John_DOE   ' });
    assert.equal(result.payload.username, 'john_doe');
  });

  // Identity strategies
  it('Identity strategies: should support HASH_SHA256 and MAP_TO_UUID', () => {
    const sha = resolveDestinationKey('user_123', 'HASH_SHA256');
    assert.match(sha, /^[a-f0-9]{64}$/);

    const uuid = resolveDestinationKey('user_123', 'MAP_TO_UUID');
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  // BSON Long and BigInt Normalization
  it('BSON normalization: should correctly normalize Long and BigInt values to decimal strings', () => {
    const mockLong = {
      _bsontype: 'Long',
      low: 1,
      high: 2,
      unsigned: false,
      toString: () => '9007199254740993',
    };

    const mapping: ObjectMapping = {
      source: { collection: 'test' },
      destination: { table: 'test' },
      identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: '_id', destinationPath: 'id' },
      ],
    };
    const engine = new TransformationEngine(mapping);

    // 1. Direct Long normalization
    const resultLong = engine.transform({
      sourceKey: 'Long:9007199254740993',
      sourceObject: 'test',
      payload: { _id: mockLong },
    } as any);

    assert.equal(resultLong.sourceKey, 'Long:9007199254740993');
    assert.equal(resultLong.destinationKey, '9007199254740993');
    assert.equal((resultLong.payload as any).id, '9007199254740993');
    assert.notEqual(resultLong.destinationKey, '[object Object]');

    // 2. BigInt normalization
    const resultBigInt = engine.transform({
      id: '1',
      _id: BigInt('9007199254740995'),
    });
    assert.equal(resultBigInt.destinationKey, '9007199254740995');
    assert.equal((resultBigInt.payload as any).id, '9007199254740995');
  });
});
