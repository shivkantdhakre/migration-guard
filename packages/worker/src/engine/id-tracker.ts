/**
 * Source-to-Destination ID Mapping Tracker
 * Specification Reference: 05_DATA_MODEL.md, FR-MAP-005
 *
 * Tracks identity correspondence when source keys/IDs change during migration.
 * Scoped by migration run and source/destination object.
 * Enforces uniqueness on (migrationRunId, sourceObject, sourceKey).
 */

import { randomUUID } from 'node:crypto';
import { IdMappingRecord } from '../types.js';

export interface IdMappingStorageAdapter {
  saveMappings(mappings: IdMappingRecord[]): Promise<void>;
  findBySourceKey(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
  ): Promise<IdMappingRecord | null>;
  findByDestinationKey(
    migrationRunId: string,
    destinationObject: string,
    destinationKey: string,
  ): Promise<IdMappingRecord | null>;
  listByRun(migrationRunId: string, sourceObject?: string): Promise<IdMappingRecord[]>;
  deleteByRun(migrationRunId: string): Promise<void>;
}

export class InMemoryIdMappingStorage implements IdMappingStorageAdapter {
  // Key: `${migrationRunId}:${sourceObject}:${sourceKey}`
  private bySourceKey = new Map<string, IdMappingRecord>();
  // Key: `${migrationRunId}:${destinationObject}:${destinationKey}`
  private byDestKey = new Map<string, IdMappingRecord>();

  public async saveMappings(mappings: IdMappingRecord[]): Promise<void> {
    for (const m of mappings) {
      const srcKey = `${m.migrationRunId}:${m.sourceObject}:${m.sourceKey}`;
      const dstKey = `${m.migrationRunId}:${m.destinationObject}:${m.destinationKey}`;
      this.bySourceKey.set(srcKey, m);
      this.byDestKey.set(dstKey, m);
    }
  }

  public async findBySourceKey(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
  ): Promise<IdMappingRecord | null> {
    const key = `${migrationRunId}:${sourceObject}:${sourceKey}`;
    return this.bySourceKey.get(key) || null;
  }

  public async findByDestinationKey(
    migrationRunId: string,
    destinationObject: string,
    destinationKey: string,
  ): Promise<IdMappingRecord | null> {
    const key = `${migrationRunId}:${destinationObject}:${destinationKey}`;
    return this.byDestKey.get(key) || null;
  }

  public async listByRun(migrationRunId: string, sourceObject?: string): Promise<IdMappingRecord[]> {
    const results: IdMappingRecord[] = [];
    for (const mapping of this.bySourceKey.values()) {
      if (mapping.migrationRunId === migrationRunId) {
        if (!sourceObject || mapping.sourceObject === sourceObject) {
          results.push(mapping);
        }
      }
    }
    return results;
  }

  public async deleteByRun(migrationRunId: string): Promise<void> {
    for (const [key, mapping] of this.bySourceKey.entries()) {
      if (mapping.migrationRunId === migrationRunId) {
        this.bySourceKey.delete(key);
        const dstKey = `${mapping.migrationRunId}:${mapping.destinationObject}:${mapping.destinationKey}`;
        this.byDestKey.delete(dstKey);
      }
    }
  }

  public clear(): void {
    this.bySourceKey.clear();
    this.byDestKey.clear();
  }
}

export class IdTracker {
  private adapter: IdMappingStorageAdapter;

  constructor(adapter?: IdMappingStorageAdapter) {
    this.adapter = adapter ?? new InMemoryIdMappingStorage();
  }

  public async recordMapping(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
    destinationObject: string,
    destinationKey: string,
  ): Promise<IdMappingRecord> {
    const record: IdMappingRecord = {
      id: randomUUID(),
      migrationRunId,
      sourceObject,
      sourceKey,
      destinationObject,
      destinationKey,
      createdAt: new Date().toISOString(),
    };
    await this.adapter.saveMappings([record]);
    return record;
  }

  public async recordBatchMappings(
    mappings: Array<{
      migrationRunId: string;
      sourceObject: string;
      sourceKey: string;
      destinationObject: string;
      destinationKey: string;
    }>,
  ): Promise<IdMappingRecord[]> {
    const records: IdMappingRecord[] = mappings.map((m) => ({
      id: randomUUID(),
      migrationRunId: m.migrationRunId,
      sourceObject: m.sourceObject,
      sourceKey: m.sourceKey,
      destinationObject: m.destinationObject,
      destinationKey: m.destinationKey,
      createdAt: new Date().toISOString(),
    }));

    await this.adapter.saveMappings(records);
    return records;
  }

  public async getDestinationKey(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
  ): Promise<string | null> {
    const record = await this.adapter.findBySourceKey(migrationRunId, sourceObject, sourceKey);
    return record ? record.destinationKey : null;
  }

  public async getSourceKey(
    migrationRunId: string,
    destinationObject: string,
    destinationKey: string,
  ): Promise<string | null> {
    const record = await this.adapter.findByDestinationKey(migrationRunId, destinationObject, destinationKey);
    return record ? record.sourceKey : null;
  }

  public async hasMapping(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
  ): Promise<boolean> {
    const record = await this.adapter.findBySourceKey(migrationRunId, sourceObject, sourceKey);
    return record !== null;
  }

  public async getMappingsByRun(
    migrationRunId: string,
    sourceObject?: string,
  ): Promise<IdMappingRecord[]> {
    return this.adapter.listByRun(migrationRunId, sourceObject);
  }

  public async deleteByRun(migrationRunId: string): Promise<void> {
    return this.adapter.deleteByRun(migrationRunId);
  }
}
