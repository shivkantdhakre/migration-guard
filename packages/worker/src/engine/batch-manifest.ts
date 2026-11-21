/**
 * Batch & Record Manifest Tracker
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 05_DATA_MODEL.md, 08_MIGRATION_ENGINE_DESIGN.md (Section 7), FR-EXEC-003
 *
 * Implements batch manifest tracking with exact states:
 * PENDING, QUEUED, RUNNING, COMMITTED, RETRY_WAIT, FAILED_RETRYABLE, FAILED_PERMANENT, OUTCOME_UNKNOWN.
 *
 * Also tracks intermediate sub-stages for crash recovery:
 * WRITE_STARTED, DESTINATION_WRITTEN, MANIFEST_COMMITTED, etc.
 */

import { randomUUID } from 'node:crypto';
import {
  BatchStatus,
  BatchSubStage,
  ErrorSummary,
  MigrationBatch,
  RecordManifest,
  SourceCursor,
} from '../types.js';

export interface BatchManifestStorageAdapter {
  saveBatch(batch: MigrationBatch): Promise<void>;
  getBatch(migrationRunId: string, batchKey: string): Promise<MigrationBatch | null>;
  listBatches(migrationRunId: string): Promise<MigrationBatch[]>;
  saveRecordManifests(manifests: RecordManifest[]): Promise<void>;
  listRecordManifests(migrationRunId: string, batchKey?: string): Promise<RecordManifest[]>;
}

export class InMemoryBatchManifestStorage implements BatchManifestStorageAdapter {
  // Key: `${migrationRunId}:${batchKey}`
  private batches = new Map<string, MigrationBatch>();
  // Key: `${migrationRunId}:${batchKey}` -> RecordManifest[]
  private recordManifests = new Map<string, RecordManifest[]>();

  public async saveBatch(batch: MigrationBatch): Promise<void> {
    const key = `${batch.migrationRunId}:${batch.batchKey}`;
    this.batches.set(key, { ...batch });
  }

  public async getBatch(migrationRunId: string, batchKey: string): Promise<MigrationBatch | null> {
    const key = `${migrationRunId}:${batchKey}`;
    const found = this.batches.get(key);
    return found ? { ...found } : null;
  }

  public async listBatches(migrationRunId: string): Promise<MigrationBatch[]> {
    const results: MigrationBatch[] = [];
    for (const b of this.batches.values()) {
      if (b.migrationRunId === migrationRunId) {
        results.push({ ...b });
      }
    }
    return results.sort((a, b) => a.sequenceNo - b.sequenceNo);
  }

  public async saveRecordManifests(manifests: RecordManifest[]): Promise<void> {
    for (const m of manifests) {
      if (!m.destinationObject || m.destinationObject.trim() === '') {
        throw new Error(`Record manifest for source key '${m.sourceKey}' is missing destinationObject.`);
      }
      if (!m.destinationKey || m.destinationKey.trim() === '') {
        throw new Error(`Record manifest for source key '${m.sourceKey}' is missing destinationKey.`);
      }

      // Deduplicate on (migrationRunId, sourceObject, sourceKey) across all batches in this run
      for (const [key, existingList] of this.recordManifests.entries()) {
        if (key.startsWith(`${m.migrationRunId}:`)) {
          const idx = existingList.findIndex(
            (e) => e.sourceObject === m.sourceObject && e.sourceKey === m.sourceKey,
          );
          if (idx >= 0) {
            existingList.splice(idx, 1);
          }
        }
      }

      const key = `${m.migrationRunId}:${m.batchKey}`;
      const existing = this.recordManifests.get(key) || [];
      existing.push({ ...m });
      this.recordManifests.set(key, existing);
    }
  }

  public async listRecordManifests(migrationRunId: string, batchKey?: string): Promise<RecordManifest[]> {
    const sanitize = (m: RecordManifest): RecordManifest => {
      if (!m.destinationObject || !m.destinationKey) {
        throw new Error(
          `[RecordManifest Integrity] Incomplete record manifest detected (id=${m.id}): destination_object or destination_key is null.`,
        );
      }
      return { ...m };
    };

    if (batchKey) {
      const key = `${migrationRunId}:${batchKey}`;
      return (this.recordManifests.get(key) || []).map(sanitize);
    }
    const all: RecordManifest[] = [];
    for (const [key, manifests] of this.recordManifests.entries()) {
      if (key.startsWith(`${migrationRunId}:`)) {
        all.push(...manifests.map(sanitize));
      }
    }
    return all;
  }

  public clear(): void {
    this.batches.clear();
    this.recordManifests.clear();
  }
}

export class BatchManifestTracker {
  private adapter: BatchManifestStorageAdapter;

  constructor(adapter?: BatchManifestStorageAdapter) {
    this.adapter = adapter ?? new InMemoryBatchManifestStorage();
  }

  public async createBatch(params: {
    migrationRunId: string;
    batchKey: string;
    sequenceNo: number;
    sourceObject: string;
    destinationObject: string;
    sourceCursorStart: SourceCursor | null;
    maxAttempts?: number;
  }): Promise<MigrationBatch> {
    const existing = await this.adapter.getBatch(params.migrationRunId, params.batchKey);
    if (existing) {
      return existing;
    }

    const batch: MigrationBatch = {
      id: randomUUID(),
      migrationRunId: params.migrationRunId,
      batchKey: params.batchKey,
      sequenceNo: params.sequenceNo,
      status: 'PENDING',
      subStage: 'IDLE',
      sourceObject: params.sourceObject,
      destinationObject: params.destinationObject,
      sourceCursorStart: params.sourceCursorStart,
      sourceCursorEnd: null,
      recordsRead: 0,
      recordsWritten: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      attemptCount: 0,
      maxAttempts: params.maxAttempts ?? 3,
    };

    await this.adapter.saveBatch(batch);
    return batch;
  }

  public async transitionState(
    migrationRunId: string,
    batchKey: string,
    newStatus: BatchStatus,
    subStage?: BatchSubStage,
    errorSummary?: ErrorSummary,
  ): Promise<MigrationBatch> {
    const batch = await this.adapter.getBatch(migrationRunId, batchKey);
    if (!batch) {
      throw new Error(`Batch not found for transition: ${migrationRunId} / ${batchKey}`);
    }

    // Validate state transitions
    this.validateTransition(batch.status, newStatus);

    batch.status = newStatus;
    if (subStage !== undefined) {
      batch.subStage = subStage;
    }

    if (newStatus === 'RUNNING' && !batch.startedAt) {
      batch.startedAt = new Date().toISOString();
      batch.attemptCount += 1;
    }

    if (newStatus === 'COMMITTED' || newStatus === 'FAILED_PERMANENT') {
      batch.completedAt = new Date().toISOString();
    }

    if (errorSummary) {
      batch.errorSummary = errorSummary;
    }

    await this.adapter.saveBatch(batch);
    return batch;
  }

  public async updateSubStage(
    migrationRunId: string,
    batchKey: string,
    subStage: BatchSubStage,
  ): Promise<MigrationBatch> {
    const batch = await this.adapter.getBatch(migrationRunId, batchKey);
    if (!batch) {
      throw new Error(`Batch not found: ${migrationRunId} / ${batchKey}`);
    }

    batch.subStage = subStage;
    await this.adapter.saveBatch(batch);
    return batch;
  }

  public async updateCounters(
    migrationRunId: string,
    batchKey: string,
    counts: {
      recordsRead?: number;
      recordsWritten?: number;
      recordsSkipped?: number;
      recordsFailed?: number;
      sourceCursorEnd?: SourceCursor | null;
    },
  ): Promise<MigrationBatch> {
    const batch = await this.adapter.getBatch(migrationRunId, batchKey);
    if (!batch) {
      throw new Error(`Batch not found: ${migrationRunId} / ${batchKey}`);
    }

    if (counts.recordsRead !== undefined) batch.recordsRead = counts.recordsRead;
    if (counts.recordsWritten !== undefined) batch.recordsWritten = counts.recordsWritten;
    if (counts.recordsSkipped !== undefined) batch.recordsSkipped = counts.recordsSkipped;
    if (counts.recordsFailed !== undefined) batch.recordsFailed = counts.recordsFailed;
    if (counts.sourceCursorEnd !== undefined) batch.sourceCursorEnd = counts.sourceCursorEnd;

    await this.adapter.saveBatch(batch);
    return batch;
  }

  public async recordManifests(
    manifests: Array<Omit<RecordManifest, 'id' | 'createdAt'>>,
  ): Promise<RecordManifest[]> {
    const records: RecordManifest[] = manifests.map((m) => ({
      ...m,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }));
    await this.adapter.saveRecordManifests(records);
    return records;
  }

  public async getBatch(migrationRunId: string, batchKey: string): Promise<MigrationBatch | null> {
    return this.adapter.getBatch(migrationRunId, batchKey);
  }

  public async listBatches(migrationRunId: string): Promise<MigrationBatch[]> {
    return this.adapter.listBatches(migrationRunId);
  }

  public async listRecordManifests(migrationRunId: string, batchKey?: string): Promise<RecordManifest[]> {
    return this.adapter.listRecordManifests(migrationRunId, batchKey);
  }

  private validateTransition(from: BatchStatus, to: BatchStatus): void {
    if (from === to) {
      return;
    }

    const allowedTransitions: Record<BatchStatus, BatchStatus[]> = {
      PENDING: ['QUEUED', 'RUNNING', 'FAILED_PERMANENT'],
      QUEUED: ['RUNNING', 'FAILED_PERMANENT'],
      RUNNING: ['COMMITTED', 'RETRY_WAIT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN'],
      COMMITTED: [], // Terminal successful state
      RETRY_WAIT: ['QUEUED', 'RUNNING', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'],
      FAILED_RETRYABLE: ['QUEUED', 'RUNNING', 'FAILED_PERMANENT', 'RETRY_WAIT'], // Can be manually re-queued or reset
      FAILED_PERMANENT: ['QUEUED', 'RUNNING', 'RETRY_WAIT'], // Can be resumed / re-queued
      OUTCOME_UNKNOWN: ['COMMITTED', 'RETRY_WAIT', 'FAILED_PERMANENT', 'RUNNING'], // After reconciliation
    };

    const allowed = allowedTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid batch state transition: cannot transition from ${from} to ${to}`);
    }
  }
}
