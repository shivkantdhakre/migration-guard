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
  it('should sort object keys deterministically', () => {
    const objA = { z: 1, b: 2, a: 3, m: 4 };
    const objB = { a: 3, m: 4, z: 1, b: 2 };

    const jsonA = canonicalizeJson(objA);
    const jsonB = canonicalizeJson(objB);

    assert.equal(jsonA, '{"a":3,"b":2,"m":4,"z":1}');
    assert.equal(jsonA, jsonB);
    assert.equal(calculateCanonicalHash(objA), calculateCanonicalHash(objB));
  });

  it('should recursively sort nested object keys', () => {
    const nestedA = {
      user: { name: 'Alice', address: { zip: '10001', city: 'NYC' }, age: 30 },
      active: true,
    };
    const nestedB = {
      active: true,
      user: { age: 30, address: { city: 'NYC', zip: '10001' }, name: 'Alice' },
    };

    assert.equal(canonicalizeJson(nestedA), canonicalizeJson(nestedB));
    assert.equal(calculateCanonicalHash(nestedA), calculateCanonicalHash(nestedB));
  });

  it('should preserve array order while canonicalizing array elements', () => {
    const arrA = [{ b: 1, a: 2 }, { d: 4, c: 3 }];
    const arrB = [{ a: 2, b: 1 }, { c: 3, d: 4 }];

    assert.equal(canonicalizeJson(arrA), canonicalizeJson(arrB));

    // Different array order must yield different json
    const arrDifferent = [{ c: 3, d: 4 }, { a: 2, b: 1 }];
    assert.notEqual(canonicalizeJson(arrA), canonicalizeJson(arrDifferent));
  });

  it('should normalize Date objects to ISO 8601 UTC strings', () => {
    const date = new Date('2026-11-19T12:30:00.000Z');
    const res = canonicalizeJson({ timestamp: date });
    assert.equal(res, '{"timestamp":"2026-11-19T12:30:00.000Z"}');
  });

  it('should normalize negative zero -0 to 0', () => {
    const res = canonicalizeJson({ val: -0 });
    assert.equal(res, '{"val":0}');
  });

  it('should omit undefined keys but preserve null values', () => {
    const obj = { a: null, b: undefined, c: 'test' };
    const res = canonicalizeJson(obj);
    assert.equal(res, '{"a":null,"c":"test"}');
  });

  it('should normalize BSON-like ObjectId and Decimal128 objects', () => {
    const mongoDoc = {
      _id: { toHexString: () => '507f1f77bcf86cd799439011' },
      balance: { _bsontype: 'Decimal128', toString: () => '12345.67' },
      name: 'Test',
    };
    const res = canonicalizeJson(mongoDoc);
    assert.equal(
      res,
      '{"_id":"507f1f77bcf86cd799439011","balance":"12345.67","name":"Test"}'
    );
  });

  it('should compute valid 64-character SHA-256 hash formatted as sha256:<hex>', () => {
    const hash = calculateCanonicalHash({ test: 123 });
    assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  });

  it('should compute record hash with optional excluded fields', () => {
    const rec1 = { id: '1', name: 'Bob', _migration_timestamp: '2026-01-01', _batch_id: 'b1' };
    const rec2 = { id: '1', name: 'Bob', _migration_timestamp: '2026-12-31', _batch_id: 'b99' };

    const hash1 = calculateRecordHash(rec1, { excludeFields: ['_migration_timestamp', '_batch_id'] });
    const hash2 = calculateRecordHash(rec2, { excludeFields: ['_migration_timestamp', '_batch_id'] });

    assert.equal(hash1, hash2);
  });

  it('should compute deterministic plan hash and mapping hash', () => {
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
