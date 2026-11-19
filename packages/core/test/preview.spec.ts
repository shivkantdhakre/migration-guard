import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { previewTransform } from '../dist/transforms/preview.js';
import type { ObjectMapping } from '../src/types/index.js';

describe('Sample Transform Preview', () => {
  const mapping: ObjectMapping = {
    source: { collection: 'users' },
    destination: { schema: 'public', table: 'users' },
    identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
    fields: [
      { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
      { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
      { sourcePath: 'created_at', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
      {
        sourcePath: 'roles',
        destinationPath: 'roles',
        transform: {
          op: 'ARRAY_TO_CHILD_ROWS',
          childTable: 'user_roles',
          parentKeyCol: 'user_id',
          itemCol: 'role_name',
        },
      },
    ],
  };

  it('should generate transformation preview with before and after diffs', () => {
    const sampleRecords = [
      {
        _id: 'user_1',
        name: '  Alice Smith  ',
        email: 'Alice@Corp.COM',
        created_at: '2026-11-19T10:00:00Z',
        roles: ['ADMIN', 'DEVELOPER'],
      },
      {
        _id: 'user_2',
        name: 'Bob Jones',
        email: 'Bob@Corp.COM',
        created_at: '2026-11-19T11:00:00Z',
        roles: ['VIEWER'],
      },
    ];

    const preview = previewTransform(mapping, sampleRecords);

    assert.equal(preview.totalSamples, 2);
    assert.equal(preview.successfulSamples, 2);
    assert.equal(preview.failedSamples, 0);
    assert.equal(preview.objectName, 'users');
    assert.equal(preview.destinationObject, 'public.users');

    // First sample inspection
    const s1 = preview.samples[0];
    assert.equal(s1.sourceKey, 'user_1');
    assert.equal(s1.destinationKey, 'user_1');
    assert.equal(s1.transformedRecord?.name, 'Alice Smith');
    assert.equal(s1.transformedRecord?.email, 'alice@corp.com');

    // Check child rows produced
    assert.ok(s1.childRows);
    assert.equal(s1.childRows.length, 2);
    assert.equal(s1.childRows[0].destinationTable, 'user_roles');
    assert.equal(s1.childRows[0].payload.user_id, 'user_1');
    assert.equal(s1.childRows[0].payload.role_name, 'ADMIN');

    // Field-level diffs
    const nameDiff = s1.fieldDiffs.find((d) => d.sourceField === 'name');
    assert.ok(nameDiff);
    assert.equal(nameDiff.sourceValue, '  Alice Smith  ');
    assert.equal(nameDiff.destinationValue, 'Alice Smith');
    assert.deepEqual(nameDiff.operations, ['TRIM_STRING']);
  });

  it('should capture row-level conversion errors without crashing the entire batch', () => {
    const strictMapping: ObjectMapping = {
      source: { collection: 'items' },
      destination: { table: 'items' },
      identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
      fields: [
        { sourcePath: 'count', destinationPath: 'count', transform: { op: 'PARSE_INTEGER', strict: true } },
      ],
    };

    const records = [
      { id: '1', count: '100' }, // valid
      { id: '2', count: 'invalid_int' }, // error!
      { id: '3', count: '300' }, // valid
    ];

    const preview = previewTransform(strictMapping, records);

    assert.equal(preview.totalSamples, 3);
    assert.equal(preview.successfulSamples, 2);
    assert.equal(preview.failedSamples, 1);

    const failedSample = preview.samples[1];
    assert.ok(failedSample.error);
    assert.match(failedSample.error, /PARSE_INTEGER/);
  });
});
