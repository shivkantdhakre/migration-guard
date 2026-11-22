import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeJson,
  calculateCanonicalHash,
  calculateRecordHash,
  calculatePlanHash,
  calculateMappingHash,
  validateUnicodeString,
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
  // Circular References vs Shared Non-Circular References (Run 005.18)
  // =========================================================================

  it('allows a shared nested object appearing under two different properties without false positive', () => {
    const shared = { name: 'Shared Config', tier: 1 };
    const doc = {
      primary: shared,
      backup: shared,
    };

    const res = canonicalizeJson(doc);
    assert.equal(
      res,
      '{"backup":{"name":"Shared Config","tier":1},"primary":{"name":"Shared Config","tier":1}}',
    );
  });

  it('allows a shared object appearing multiple times in an array without false positive', () => {
    const item = { id: 'item_1', active: true };
    const doc = {
      list: [item, item, { ...item }, item],
    };

    const res = canonicalizeJson(doc);
    assert.equal(
      res,
      '{"list":[{"active":true,"id":"item_1"},{"active":true,"id":"item_1"},{"active":true,"id":"item_1"},{"active":true,"id":"item_1"}]}',
    );
  });

  it('allows reuse of the same BSON-like ObjectId instance in two properties', () => {
    const oid = {
      _bsontype: 'ObjectId',
      toString: () => '507f1f77bcf86cd799439011',
      toHexString: () => '507f1f77bcf86cd799439011',
    };
    const doc = {
      createdById: oid,
      updatedById: oid,
    };

    const res = canonicalizeJson(doc);
    assert.equal(
      res,
      '{"createdById":"507f1f77bcf86cd799439011","updatedById":"507f1f77bcf86cd799439011"}',
    );
  });

  it('explicitly detects and rejects a genuinely circular object', () => {
    const circular: Record<string, any> = { a: 1 };
    circular.self = circular;

    assert.throws(
      () => canonicalizeJson(circular),
      /Converting circular structure to JSON|Circular reference detected/,
    );
  });

  it('explicitly detects and rejects a genuinely circular array', () => {
    const arr: any[] = [1, 2];
    arr.push(arr);

    assert.throws(
      () => canonicalizeJson(arr),
      /Converting circular structure to JSON|Circular reference detected/,
    );
  });

  it('explicitly detects and rejects nested circular references', () => {
    const a: any = { name: 'A' };
    const b: any = { name: 'B', toA: a };
    const c: any = { name: 'C', toB: b };
    a.toC = c;

    assert.throws(
      () => canonicalizeJson(a),
      /Converting circular structure to JSON|Circular reference detected/,
    );
  });

  // =========================================================================
  // RFC 8785 Unicode Conformance & Surrogate Validation (Run 005.18)
  // =========================================================================

  it('accepts valid BMP Unicode characters without modification', () => {
    const doc = {
      latin: 'Café & naïve résumé',
      cyrillic: 'Привет мир',
      cjk: '你好世界 快適',
      greek: 'Ελληνικά',
    };
    const res = canonicalizeJson(doc);
    assert.equal(
      res,
      '{"cjk":"你好世界 快適","cyrillic":"Привет мир","greek":"Ελληνικά","latin":"Café & naïve résumé"}',
    );
  });

  it('accepts valid supplementary Unicode characters', () => {
    // Mathematical Alphanumeric Symbols: U+1D4B3 (𝒳) = \uD835\uDCB3
    const doc = { mathVar: '𝒳 \uD835\uDCB3' };
    const res = canonicalizeJson(doc);
    assert.equal(res, '{"mathVar":"𝒳 𝒳"}');
  });

  it('accepts valid emoji surrogate pairs', () => {
    // U+1F600 (😀) = \uD83D\uDE00, U+1F680 (🚀) = \uD83D\uDE80
    const doc = {
      status: '🚀 Ready 😀',
      flag: '🛡️ MigrationGuard',
    };
    const res = canonicalizeJson(doc);
    assert.equal(res, '{"flag":"🛡️ MigrationGuard","status":"🚀 Ready 😀"}');
  });

  it('explicitly rejects isolated high surrogates in string values', () => {
    // \uD800 without following low surrogate
    assert.throws(
      () => canonicalizeJson({ test: 'LoneHigh\uD800' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: '\uD800' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: '\uD800\uD800' }), // Two high surrogates together
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: '\uD800abc' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
  });

  it('explicitly rejects isolated low surrogates in string values', () => {
    // \uDC00 without preceding high surrogate
    assert.throws(
      () => canonicalizeJson({ test: 'LoneLow\uDC00' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: '\uDC00' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: '\uDC00\uDC00' }), // Two low surrogates together
      /Invalid Unicode string value|lone surrogate/i,
    );
    assert.throws(
      () => canonicalizeJson({ test: 'abc\uDC00def' }),
      /Invalid Unicode string value|lone surrogate/i,
    );
  });

  it('explicitly rejects malformed surrogate pairs in object keys / property names', () => {
    // Lone high surrogate in property name
    assert.throws(
      () => canonicalizeJson({ ['bad\uD800key']: 123 }),
      /Invalid Unicode property name|lone surrogate/i,
    );
    // Lone low surrogate in property name
    assert.throws(
      () => canonicalizeJson({ ['bad\uDC00key']: 456 }),
      /Invalid Unicode property name|lone surrogate/i,
    );
  });

  it('explicitly rejects malformed surrogate pairs in nested values and arrays', () => {
    const nested = {
      data: {
        items: ['valid', 'good', 'corrupted\uD83D'],
      },
    };
    assert.throws(
      () => canonicalizeJson(nested),
      /Invalid Unicode string value|lone surrogate/i,
    );
  });

  it('verifies strict UTF-16 code unit property sorting with Unicode keys', () => {
    const doc: Record<string, string> = {
      'z': 'last ascii',
      'a': 'first ascii',
      'A': 'capital ascii',
      '\u00e9': 'e-acute (U+00E9)',
      '\ud83d\ude00': 'grinning (U+1F600, high surrogate U+D83D)',
      '1': 'digit (U+0031)',
      '': 'empty key',
    };
    const res = canonicalizeJson(doc);
    assert.equal(
      res,
      '{"":"empty key","1":"digit (U+0031)","A":"capital ascii","a":"first ascii","z":"last ascii","é":"e-acute (U+00E9)","😀":"grinning (U+1F600, high surrogate U+D83D)"}',
    );
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
