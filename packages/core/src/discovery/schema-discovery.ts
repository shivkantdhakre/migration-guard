import {
  SchemaSnapshot,
  ObjectSchema,
  FieldSchema,
  ConstraintDefinition,
  IndexDefinition,
  DatabaseEngine,
} from '../types/index.js';
import { detectType } from '../profiling/profiler.js';
import { normalizeBsonValue } from '../transforms/operations.js';

export interface SchemaDiffChange {
  type: 'OBJECT_ADDED' | 'OBJECT_REMOVED' | 'FIELD_ADDED' | 'FIELD_REMOVED' | 'FIELD_TYPE_CHANGED' | 'FIELD_NULLABILITY_CHANGED' | 'CONSTRAINT_CHANGED';
  objectName: string;
  fieldPath?: string;
  detail: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface SchemaDiffResult {
  snapshotBeforeId: string;
  snapshotAfterId: string;
  hasChanges: boolean;
  changes: SchemaDiffChange[];
  summary: {
    objectsAdded: number;
    objectsRemoved: number;
    fieldsAdded: number;
    fieldsRemoved: number;
    fieldsModified: number;
  };
}

/**
 * Discovers schema for MongoDB collections by inspecting sample documents and collection indexes
 */
export function buildMongoCollectionSchema(
  collectionName: string,
  sampleDocuments: Array<Record<string, unknown>>,
  indexes: Array<IndexDefinition> = []
): ObjectSchema {
  const fieldsMap = new Map<string, {
    types: Record<string, number>;
    nullCount: number;
    total: number;
  }>();

  function scanDoc(obj: Record<string, unknown>, prefix = '', depth = 1): void {
    if (depth > 6) return;
    for (const [k, v] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (!fieldsMap.has(fullPath)) {
        fieldsMap.set(fullPath, { types: {}, nullCount: 0, total: 0 });
      }
      const entry = fieldsMap.get(fullPath)!;
      entry.total++;

      const normalized = normalizeBsonValue(v);
      const t = detectType(normalized);
      entry.types[t] = (entry.types[t] || 0) + 1;

      if (normalized === null || normalized === undefined) {
        entry.nullCount++;
      } else if (typeof normalized === 'object' && !Array.isArray(normalized)) {
        scanDoc(normalized as Record<string, unknown>, fullPath, depth + 1);
      }
    }
  }

  for (const doc of sampleDocuments) {
    scanDoc(doc);
  }

  const fields: FieldSchema[] = [];
  const totalDocs = sampleDocuments.length;

  for (const [path, info] of fieldsMap.entries()) {
    const isPrimaryKey = path === '_id';
    // Determine predominant type
    let predominantType = 'string';
    let maxCount = -1;
    for (const [t, c] of Object.entries(info.types)) {
      if (t !== 'null' && t !== 'undefined' && c > maxCount) {
        maxCount = c;
        predominantType = t;
      }
    }

    fields.push({
      name: path.includes('.') ? path.split('.').pop()! : path,
      path,
      dataType: predominantType,
      nativeType: predominantType,
      nullable: isPrimaryKey ? false : info.nullCount > 0 || info.total < totalDocs,
      isPrimaryKey,
      typeDistribution: info.types,
    });
  }

  // Ensure _id exists even if sample is empty
  if (!fields.some((f) => f.path === '_id')) {
    fields.unshift({
      name: '_id',
      path: '_id',
      dataType: 'objectId',
      nativeType: 'objectId',
      nullable: false,
      isPrimaryKey: true,
    });
  }

  return {
    name: collectionName,
    type: 'COLLECTION',
    fields,
    indexes,
    recordCountEstimate: totalDocs,
  };
}

/**
 * Compares two schema snapshots and identifies schema evolution differences
 */
export function compareSchemaSnapshots(
  before: SchemaSnapshot,
  after: SchemaSnapshot
): SchemaDiffResult {
  const changes: SchemaDiffChange[] = [];
  const beforeObjMap = new Map(before.objects.map((o) => [o.name.toLowerCase(), o]));
  const afterObjMap = new Map(after.objects.map((o) => [o.name.toLowerCase(), o]));

  let objectsAdded = 0;
  let objectsRemoved = 0;
  let fieldsAdded = 0;
  let fieldsRemoved = 0;
  let fieldsModified = 0;

  // Check removed objects
  for (const [name, obj] of beforeObjMap) {
    if (!afterObjMap.has(name)) {
      objectsRemoved++;
      changes.push({
        type: 'OBJECT_REMOVED',
        objectName: obj.name,
        detail: `Object "${obj.name}" was removed`,
      });
    }
  }

  // Check added and modified objects
  for (const [name, afterObj] of afterObjMap) {
    const beforeObj = beforeObjMap.get(name);
    if (!beforeObj) {
      objectsAdded++;
      changes.push({
        type: 'OBJECT_ADDED',
        objectName: afterObj.name,
        detail: `Object "${afterObj.name}" was added`,
      });
      continue;
    }

    // Compare fields
    const beforeFieldMap = new Map(beforeObj.fields.map((f) => [f.path.toLowerCase(), f]));
    const afterFieldMap = new Map(afterObj.fields.map((f) => [f.path.toLowerCase(), f]));

    for (const [path, f] of beforeFieldMap) {
      if (!afterFieldMap.has(path)) {
        fieldsRemoved++;
        changes.push({
          type: 'FIELD_REMOVED',
          objectName: afterObj.name,
          fieldPath: f.path,
          detail: `Field "${f.path}" was removed from "${afterObj.name}"`,
        });
      }
    }

    for (const [path, afterF] of afterFieldMap) {
      const beforeF = beforeFieldMap.get(path);
      if (!beforeF) {
        fieldsAdded++;
        changes.push({
          type: 'FIELD_ADDED',
          objectName: afterObj.name,
          fieldPath: afterF.path,
          detail: `Field "${afterF.path}" (${afterF.dataType}) was added to "${afterObj.name}"`,
        });
      } else {
        // Compare type
        if (beforeF.dataType.toLowerCase() !== afterF.dataType.toLowerCase()) {
          fieldsModified++;
          changes.push({
            type: 'FIELD_TYPE_CHANGED',
            objectName: afterObj.name,
            fieldPath: afterF.path,
            detail: `Data type for "${afterF.path}" changed from "${beforeF.dataType}" to "${afterF.dataType}"`,
            oldValue: beforeF.dataType,
            newValue: afterF.dataType,
          });
        }
        // Compare nullability
        if (beforeF.nullable !== afterF.nullable) {
          fieldsModified++;
          changes.push({
            type: 'FIELD_NULLABILITY_CHANGED',
            objectName: afterObj.name,
            fieldPath: afterF.path,
            detail: `Nullability for "${afterF.path}" changed from ${beforeF.nullable} to ${afterF.nullable}`,
            oldValue: beforeF.nullable,
            newValue: afterF.nullable,
          });
        }
      }
    }
  }

  return {
    snapshotBeforeId: before.id,
    snapshotAfterId: after.id,
    hasChanges: changes.length > 0,
    changes,
    summary: {
      objectsAdded,
      objectsRemoved,
      fieldsAdded,
      fieldsRemoved,
      fieldsModified,
    },
  };
}

/**
 * Creates an immutable SchemaSnapshot data object
 */
export function createSchemaSnapshot(params: {
  id: string;
  workspaceId: string;
  connectionId: string;
  connectionVersion: number;
  schemaVersion: number;
  engine: DatabaseEngine;
  objects: ObjectSchema[];
  samplingMethod?: 'FULL' | 'BOUNDED_SAMPLE';
  sampleSize?: number;
  durationMs?: number;
}): SchemaSnapshot {
  return {
    id: params.id,
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
    connectionVersion: params.connectionVersion,
    schemaVersion: params.schemaVersion,
    engine: params.engine,
    objects: params.objects,
    discoveryMetadata: {
      discoveredAt: new Date().toISOString(),
      samplingMethod: params.samplingMethod || 'BOUNDED_SAMPLE',
      sampleSize: params.sampleSize,
      durationMs: params.durationMs || 0,
    },
    createdAt: new Date().toISOString(),
  };
}
