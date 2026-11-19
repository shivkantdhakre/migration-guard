import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMappingDsl,
  validateMappingAgainstSchemas,
  ALLOWED_TRANSFORM_OPS,
} from '../dist/mapping/dsl-validator.js';
import type { MappingDefinition, SchemaSnapshot } from '../src/types/index.js';

describe('Mapping DSL & Schema Validation', () => {
  it('should validate all 13 allowlisted operations in the allowlist set', () => {
    assert.equal(ALLOWED_TRANSFORM_OPS.size, 13);
    const expected = [
      'RENAME',
      'TRIM_STRING',
      'LOWERCASE',
      'UPPERCASE',
      'PARSE_INTEGER',
      'PARSE_DECIMAL',
      'PARSE_TIMESTAMP',
      'TO_JSONB',
      'FLATTEN_OBJECT',
      'ARRAY_TO_CHILD_ROWS',
      'SET_DEFAULT',
      'NULL_IF_EMPTY',
      'PRESERVE_SOURCE_ID',
    ];
    for (const op of expected) {
      assert.ok(ALLOWED_TRANSFORM_OPS.has(op as any), `Operation ${op} missing from allowlist`);
    }
  });

  it('should accept valid mapping DSL', () => {
    const mapping: MappingDefinition = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
            { sourcePath: 'created_at', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
          ],
        },
      ],
    };
    const res = validateMappingDsl(mapping);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
  });

  it('should reject unallowlisted operations with UNSUPPORTED_OPERATION', () => {
    const invalidMapping = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            {
              sourcePath: 'status',
              destinationPath: 'status',
              transform: { op: 'CUSTOM_JS_EVAL' },
            },
          ],
        },
      ],
    };
    const res = validateMappingDsl(invalidMapping);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'UNSUPPORTED_OPERATION'));
  });

  it('should strictly reject scripting / code injection attempts', () => {
    const injectionAttempt = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            {
              sourcePath: 'name',
              destinationPath: 'name',
              transform: {
                op: 'TRIM_STRING',
                script: 'console.log("hacked")',
                code: 'eval("evil")',
              },
            },
          ],
        },
      ],
    };
    const res = validateMappingDsl(injectionAttempt);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'FORBIDDEN_SCRIPT_KEY'));
  });

  it('should detect duplicate destination column mapping collisions', () => {
    const collisionMapping = {
      version: 1,
      objects: [
        {
          source: { collection: 'users' },
          destination: { table: 'users' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'first_name', destinationPath: 'full_name' },
            { sourcePath: 'last_name', destinationPath: 'full_name' }, // Collision!
          ],
        },
      ],
    };
    const res = validateMappingDsl(collisionMapping);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_DESTINATION_COLUMN'));
  });

  it('should validate operation-specific parameter rules', () => {
    const invalidParamsMapping = {
      version: 1,
      objects: [
        {
          source: { collection: 'orders' },
          destination: { table: 'orders' },
          identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            {
              sourcePath: 'items',
              destinationPath: 'items',
              transform: { op: 'ARRAY_TO_CHILD_ROWS', childTable: '', parentKeyCol: '' }, // Missing required names
            },
            {
              sourcePath: 'code',
              destinationPath: 'code',
              transform: { op: 'PARSE_INTEGER', radix: 50 }, // Invalid radix
            },
          ],
        },
      ],
    };
    const res = validateMappingDsl(invalidParamsMapping);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'MISSING_CHILD_TABLE'));
    assert.ok(res.errors.some((e) => e.code === 'INVALID_RADIX'));
  });

  it('should validate mapping against source and destination schema snapshots', () => {
    const sourceSchema: SchemaSnapshot = {
      id: 'src-snap',
      workspaceId: 'ws1',
      connectionId: 'c1',
      connectionVersion: 1,
      schemaVersion: 1,
      engine: 'MONGODB',
      objects: [
        {
          name: 'customers',
          type: 'COLLECTION',
          fields: [
            { name: '_id', path: '_id', dataType: 'objectId', nullable: false, isPrimaryKey: true },
            { name: 'name', path: 'name', dataType: 'string', nullable: true },
          ],
        },
      ],
      discoveryMetadata: { discoveredAt: '', samplingMethod: 'FULL', durationMs: 0 },
      createdAt: '',
    };

    const destSchema: SchemaSnapshot = {
      id: 'dst-snap',
      workspaceId: 'ws1',
      connectionId: 'c2',
      connectionVersion: 1,
      schemaVersion: 1,
      engine: 'POSTGRESQL',
      objects: [
        {
          name: 'customers',
          schema: 'public',
          type: 'TABLE',
          fields: [
            { name: 'id', path: 'id', dataType: 'text', nullable: false, isPrimaryKey: true },
            { name: 'name', path: 'name', dataType: 'text', nullable: true },
            { name: 'mandatory_code', path: 'mandatory_code', dataType: 'text', nullable: false }, // Not mapped & no default!
          ],
        },
      ],
      discoveryMetadata: { discoveredAt: '', samplingMethod: 'FULL', durationMs: 0 },
      createdAt: '',
    };

    const mapping: MappingDefinition = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'name', destinationPath: 'name' },
            { sourcePath: 'unobserved_field', destinationPath: 'non_existent_column' },
          ],
        },
      ],
    };

    const res = validateMappingAgainstSchemas(mapping, sourceSchema, destSchema);
    assert.equal(res.valid, false);

    // Should flag missing destination column
    assert.ok(res.errors.some((e) => e.code === 'DESTINATION_COLUMN_NOT_FOUND'));

    // Should flag required non-nullable unmapped column
    assert.ok(res.errors.some((e) => e.code === 'UNMAPPED_REQUIRED_COLUMN'));

    // Should warn on unobserved source field
    assert.ok(res.warnings.some((w) => w.code === 'SOURCE_FIELD_NOT_OBSERVED'));
  });
});
