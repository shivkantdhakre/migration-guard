import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMongoCollectionSchema,
  compareSchemaSnapshots,
  createSchemaSnapshot,
} from '../dist/discovery/schema-discovery.js';
import type { SchemaSnapshot } from '../src/types/index.js';

describe('Schema Discovery & Snapshot Comparison', () => {
  it('should infer schema from MongoDB sample documents and indexes', () => {
    const sampleDocs = [
      {
        _id: { toHexString: () => '507f1f77bcf86cd799439011' },
        name: 'Alice',
        age: 28,
        active: true,
        address: { city: 'Seattle', zip: '98101' },
      },
      {
        _id: { toHexString: () => '507f1f77bcf86cd799439012' },
        name: 'Bob',
        age: null, // Nullable age
        active: false,
        address: { city: 'Portland', zip: '97201' },
      },
    ];

    const indexes = [
      { name: '_id_', columns: ['_id'], isUnique: true, isPrimary: true },
      { name: 'idx_name', columns: ['name'], isUnique: false },
    ];

    const schema = buildMongoCollectionSchema('users', sampleDocs, indexes);

    assert.equal(schema.name, 'users');
    assert.equal(schema.type, 'COLLECTION');
    assert.equal(schema.indexes?.length, 2);

    const idField = schema.fields.find((f) => f.path === '_id');
    assert.ok(idField);
    assert.equal(idField.isPrimaryKey, true);
    assert.equal(idField.nullable, false);

    const ageField = schema.fields.find((f) => f.path === 'age');
    assert.ok(ageField);
    assert.equal(ageField.nullable, true);
    assert.equal(ageField.dataType, 'integer');

    const addressCityField = schema.fields.find((f) => f.path === 'address.city');
    assert.ok(addressCityField);
    assert.equal(addressCityField.dataType, 'string');
  });

  it('should detect added, removed, and modified fields and tables between snapshots', () => {
    const snapV1: SchemaSnapshot = createSchemaSnapshot({
      id: 'snap-1',
      workspaceId: 'ws1',
      connectionId: 'c1',
      connectionVersion: 1,
      schemaVersion: 1,
      engine: 'POSTGRESQL',
      objects: [
        {
          name: 'users',
          type: 'TABLE',
          fields: [
            { name: 'id', path: 'id', dataType: 'text', nullable: false, isPrimaryKey: true },
            { name: 'email', path: 'email', dataType: 'varchar', nullable: false },
            { name: 'legacy_col', path: 'legacy_col', dataType: 'text', nullable: true },
          ],
        },
        {
          name: 'old_archive',
          type: 'TABLE',
          fields: [
            { name: 'id', path: 'id', dataType: 'text', nullable: false, isPrimaryKey: true },
          ],
        },
      ],
    });

    const snapV2: SchemaSnapshot = createSchemaSnapshot({
      id: 'snap-2',
      workspaceId: 'ws1',
      connectionId: 'c1',
      connectionVersion: 2,
      schemaVersion: 2,
      engine: 'POSTGRESQL',
      objects: [
        {
          name: 'users',
          type: 'TABLE',
          fields: [
            { name: 'id', path: 'id', dataType: 'text', nullable: false, isPrimaryKey: true },
            { name: 'email', path: 'email', dataType: 'text', nullable: false }, // Type changed from varchar to text
            { name: 'is_active', path: 'is_active', dataType: 'boolean', nullable: true }, // Added field
            // legacy_col was removed!
          ],
        },
        {
          name: 'audit_logs', // Added table!
          type: 'TABLE',
          fields: [
            { name: 'id', path: 'id', dataType: 'uuid', nullable: false, isPrimaryKey: true },
          ],
        },
        // old_archive was removed!
      ],
    });

    const diff = compareSchemaSnapshots(snapV1, snapV2);

    assert.equal(diff.hasChanges, true);
    assert.equal(diff.summary.objectsAdded, 1);
    assert.equal(diff.summary.objectsRemoved, 1);
    assert.equal(diff.summary.fieldsAdded, 1);
    assert.equal(diff.summary.fieldsRemoved, 1);
    assert.equal(diff.summary.fieldsModified, 1);

    assert.ok(diff.changes.some((c) => c.type === 'OBJECT_ADDED' && c.objectName === 'audit_logs'));
    assert.ok(diff.changes.some((c) => c.type === 'OBJECT_REMOVED' && c.objectName === 'old_archive'));
    assert.ok(diff.changes.some((c) => c.type === 'FIELD_ADDED' && c.fieldPath === 'is_active'));
    assert.ok(diff.changes.some((c) => c.type === 'FIELD_REMOVED' && c.fieldPath === 'legacy_col'));
    assert.ok(diff.changes.some((c) => c.type === 'FIELD_TYPE_CHANGED' && c.fieldPath === 'email'));
  });
});
