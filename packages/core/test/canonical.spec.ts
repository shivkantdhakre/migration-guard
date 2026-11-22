import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeJson,
  calculateCanonicalHash,
  calculateRecordHash,
  calculatePlanHash,
  calculateMappingHash,
  sha256Hex,
} from '../dist/canonical/index.js';

describe('Canonical Hashing & RFC 8785 Compliance', () => {
  // =========================================================================
  // RFC 8785 Known-Answer Test (KAT) Vectors (Independent Fixed Oracles)
  // =========================================================================

  it('KAT 1: verifies RFC 8785 UTF-16 code unit key ordering with Unicode and special characters', () => {
    // Unordered input object with mixed Unicode, ASCII, numbers, and symbols
    const input = {
      '\ud83d\ude00': 'grinning', // U+D83D (Surrogate)
      '\u20ac': 'euro',           // U+20AC (Euro)
      'a': 'alpha',               // U+0061
      '1': 1,                     // U+0031
      '\u00e9': 'e-acute',        // U+00E9
      '_': 'underscore',          // U+005F
      'A': 'upper',               // U+0041
    };

    // Fixed, independently pre-computed expected canonical string and SHA-256 digest
    const expectedCanonical = '{"1":1,"A":"upper","_":"underscore","a":"alpha","é":"e-acute","€":"euro","😀":"grinning"}';
    const expectedDigest = 'e0addc349d42ec3869fdf9a9e22eed85e1296625200a270ef923c49eb61fed43';
    const expectedHash = `sha256:${expectedDigest}`;

    const canonical = canonicalizeJson(input);
    const computedHash = calculateCanonicalHash(input);

    assert.equal(canonical, expectedCanonical);
    assert.equal(computedHash, expectedHash);
    assert.match(computedHash, /^sha256:[a-f0-9]{64}$/);
  });

  it('KAT 2: verifies escaped characters and whitespace strings per RFC 8785 §3.2.2', () => {
    const input = {
      str: 'Tab\tNewline\nQuote"Backslash\\CR\rFF\fBS\b',
    };

    const expectedCanonical = '{"str":"Tab\\tNewline\\nQuote\\"Backslash\\\\CR\\rFF\\fBS\\b"}';
    const expectedDigest = '052d4ba9f8f351d098d3ae14e1599799008d4a46ee901f3716b05d0b3348591b';
    const expectedHash = `sha256:${expectedDigest}`;

    const canonical = canonicalizeJson(input);
    const computedHash = calculateCanonicalHash(input);

    assert.equal(canonical, expectedCanonical);
    assert.equal(computedHash, expectedHash);
  });

  it('KAT 3: verifies numeric canonicalization, negative zero normalization, and float precision', () => {
    const input = {
      zero: -0,
      posZero: 0,
      int: 100,
      neg: -42,
      float: 3.141592653589793,
      small: 0.0001,
    };

    const expectedCanonical = '{"float":3.141592653589793,"int":100,"neg":-42,"posZero":0,"small":0.0001,"zero":0}';
    const expectedDigest = '06c7d3f6d5ebf2bf1c7088160c7c9db8390266748e839c010240df66b5b1ca1c';
    const expectedHash = `sha256:${expectedDigest}`;

    const canonical = canonicalizeJson(input);
    const computedHash = calculateCanonicalHash(input);

    assert.equal(canonical, expectedCanonical);
    assert.equal(computedHash, expectedHash);
  });

  it('KAT 4: verifies nested structures, array element order preservation, and inner canonicalization', () => {
    const input = {
      meta: {
        tags: ['a', 'b'],
        active: true,
      },
      items: [
        { name: 'first', id: 1 },
        { id: 2, name: 'second' },
      ],
    };

    const expectedCanonical = '{"items":[{"id":1,"name":"first"},{"id":2,"name":"second"}],"meta":{"active":true,"tags":["a","b"]}}';
    const expectedDigest = '8d8112145a35f98aad819f001431e1ca411e172b9a29b8a10cbafca46ed8f349';
    const expectedHash = `sha256:${expectedDigest}`;

    const canonical = canonicalizeJson(input);
    const computedHash = calculateCanonicalHash(input);

    assert.equal(canonical, expectedCanonical);
    assert.equal(computedHash, expectedHash);
  });

  // =========================================================================
  // Deterministic Insertion Order Invariance
  // =========================================================================

  it('guarantees deterministic canonical output regardless of JavaScript object insertion order', () => {
    // 3 variations of the same dictionary created in different insertion orders
    const order1: Record<string, any> = {};
    order1.z = 10;
    order1.a = 20;
    order1.m = { beta: 2, alpha: 1 };
    order1.b = [3, 2, 1];

    const order2: Record<string, any> = {};
    order2.m = { alpha: 1, beta: 2 };
    order2.b = [3, 2, 1];
    order2.z = 10;
    order2.a = 20;

    const order3: Record<string, any> = {};
    order3.a = 20;
    order3.b = [3, 2, 1];
    order3.m = { beta: 2, alpha: 1 };
    order3.z = 10;

    const json1 = canonicalizeJson(order1);
    const json2 = canonicalizeJson(order2);
    const json3 = canonicalizeJson(order3);

    assert.equal(json1, json2);
    assert.equal(json2, json3);
    assert.equal(calculateCanonicalHash(order1), calculateCanonicalHash(order2));
    assert.equal(calculateCanonicalHash(order2), calculateCanonicalHash(order3));
  });

  // =========================================================================
  // Platform Extensions (Date, BigInt, BSON, Binary)
  // =========================================================================

  it('platform extension: normalizes Date objects to ISO 8601 UTC strings', () => {
    const date = new Date('2026-11-22T12:00:00.000Z');
    const res = canonicalizeJson({ timestamp: date });
    assert.equal(res, '{"timestamp":"2026-11-22T12:00:00.000Z"}');
  });

  it('platform extension: serializes BigInt to string representation', () => {
    const res = canonicalizeJson({ count: 9007199254740993n });
    assert.equal(res, '{"count":"9007199254740993"}');
  });

  it('platform extension: serializes Uint8Array / Buffer to Base64 strings', () => {
    const buffer = Buffer.from('MigrationGuard Secure Canonicalization');
    const res = canonicalizeJson({ payload: buffer });
    assert.equal(res, '{"payload":"TWlncmF0aW9uR3VhcmQgU2VjdXJlIENhbm9uaWNhbGl6YXRpb24="}');
  });

  it('platform extension: normalizes BSON-like ObjectId and Decimal128 objects', () => {
    const mongoDoc = {
      _id: { toHexString: () => '507f1f77bcf86cd799439011' },
      balance: { _bsontype: 'Decimal128', toString: () => '12345.67' },
      name: 'Test Customer',
    };
    const res = canonicalizeJson(mongoDoc);
    assert.equal(
      res,
      '{"_id":"507f1f77bcf86cd799439011","balance":"12345.67","name":"Test Customer"}',
    );
  });

  // =========================================================================
  // Invalid and Unsupported Values (Fail-Closed Rejection)
  // =========================================================================

  it('explicitly rejects NaN and non-finite numbers', () => {
    assert.throws(
      () => canonicalizeJson({ val: NaN }),
      /Invalid non-finite number in canonicalization: NaN/,
    );
    assert.throws(
      () => canonicalizeJson({ val: Infinity }),
      /Invalid non-finite number in canonicalization: Infinity/,
    );
    assert.throws(
      () => canonicalizeJson({ val: -Infinity }),
      /Invalid non-finite number in canonicalization: -Infinity/,
    );
  });

  it('explicitly rejects invalid Date objects', () => {
    const invalidDate = new Date('not-a-valid-date');
    assert.throws(
      () => canonicalizeJson({ createdAt: invalidDate }),
      /Invalid Date in canonicalization/,
    );
  });

  it('explicitly detects and rejects circular object references', () => {
    const circular: Record<string, any> = { a: 1 };
    circular.self = circular;

    assert.throws(
      () => canonicalizeJson(circular),
      /Circular reference detected in canonicalization/,
    );
  });

  it('omits undefined, functions, and symbols while preserving explicit nulls', () => {
    const obj = {
      a: null,
      b: undefined,
      c: () => 'hello',
      d: Symbol('test'),
      e: 'valid',
    };
    const res = canonicalizeJson(obj);
    assert.equal(res, '{"a":null,"e":"valid"}');
  });

  // =========================================================================
  // Plan & Record Hash Functions
  // =========================================================================

  it('computes record hash with optional excluded transient fields', () => {
    const rec1 = { id: '1', name: 'Bob', _migration_timestamp: '2026-01-01', _batch_id: 'b1' };
    const rec2 = { id: '1', name: 'Bob', _migration_timestamp: '2026-12-31', _batch_id: 'b99' };

    const hash1 = calculateRecordHash(rec1, { excludeFields: ['_migration_timestamp', '_batch_id'] });
    const hash2 = calculateRecordHash(rec2, { excludeFields: ['_migration_timestamp', '_batch_id'] });

    assert.equal(hash1, hash2);
    assert.match(hash1, /^sha256:[a-f0-9]{64}$/);
  });

  it('computes deterministic plan hash and mapping hash', () => {
    const plan = {
      version: 1,
      sourceConnectionId: 'c1',
      destinationConnectionId: 'c2',
      executionConfig: { batchSize: 500, writeMode: 'UPSERT' },
    };
    const hashA = calculatePlanHash(plan);
    const hashB = calculatePlanHash({ ...plan });
    assert.equal(hashA, hashB);

    const mapping = {
      version: 1,
      objects: [{ source: { collection: 'users' }, destination: { table: 'users' } }],
    };
    assert.equal(calculateMappingHash(mapping), calculateMappingHash({ ...mapping }));
  });
});
