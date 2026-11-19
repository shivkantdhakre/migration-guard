/**
 * Migration Checkpoint Manager
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md (Section 10), 08_MIGRATION_ENGINE_DESIGN.md (Section 9), FR-REC-001
 *
 * Manages durable checkpoints representing the highest source cursor/range
 * whose destination effects and batch manifests are durable.
 * Advance only after destination writes and record manifests have succeeded.
 */

import { MigrationBatch, MigrationCheckpoint, SourceCursor } from '../types.js';

export interface CheckpointStorageAdapter {
  saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void>;
  getCheckpoint(migrationRunId: string, sourceObject: string): Promise<MigrationCheckpoint | null>;
  deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void>;
}

export class InMemoryCheckpointStorage implements CheckpointStorageAdapter {
  // Key: `${migrationRunId}:${sourceObject}`
  private checkpoints = new Map<string, MigrationCheckpoint>();

  public async saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
    const key = `${checkpoint.migrationRunId}:${checkpoint.sourceObject}`;
    this.checkpoints.set(key, { ...checkpoint });
  }

  public async getCheckpoint(
    migrationRunId: string,
    sourceObject: string,
  ): Promise<MigrationCheckpoint | null> {
    const key = `${migrationRunId}:${sourceObject}`;
    const found = this.checkpoints.get(key);
    return found ? { ...found } : null;
  }

  public async deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void> {
    const key = `${migrationRunId}:${sourceObject}`;
    this.checkpoints.delete(key);
  }

  public clear(): void {
    this.checkpoints.clear();
  }
}

export class CheckpointManager {
  private adapter: CheckpointStorageAdapter;

  constructor(adapter?: CheckpointStorageAdapter) {
    this.adapter = adapter ?? new InMemoryCheckpointStorage();
  }

  public async getCheckpoint(
    migrationRunId: string,
    sourceObject: string,
  ): Promise<MigrationCheckpoint | null> {
    return this.adapter.getCheckpoint(migrationRunId, sourceObject);
  }

  public async saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
    await this.adapter.saveCheckpoint(checkpoint);
  }

  /**
   * Advances the checkpoint for a migration run and source object.
   * Enforces that sequence numbers are monotonic and never regress.
   */
  public async advanceCheckpoint(params: {
    migrationRunId: string;
    sourceObject: string;
    batch: MigrationBatch;
    planVersionId: string;
    mappingVersionId: string;
    recordsCommittedCount: number;
    cursorEnd: SourceCursor | null;
  }): Promise<MigrationCheckpoint> {
    const current = await this.getCheckpoint(params.migrationRunId, params.sourceObject);

    if (current && params.batch.sequenceNo < current.lastCommittedSequenceNo) {
      throw new Error(
        `Cannot regress checkpoint sequence: current is ${current.lastCommittedSequenceNo}, attempted ${params.batch.sequenceNo}`,
      );
    }

    const totalRecordsCommitted = (current?.totalRecordsCommitted ?? 0) + params.recordsCommittedCount;

    const checkpoint: MigrationCheckpoint = {
      migrationRunId: params.migrationRunId,
      sourceObject: params.sourceObject,
      lastCommittedSequenceNo: params.batch.sequenceNo,
      lastCommittedBatchKey: params.batch.batchKey,
      lastCommittedCursor: params.cursorEnd,
      planVersionId: params.planVersionId,
      mappingVersionId: params.mappingVersionId,
      totalRecordsCommitted,
      updatedAt: new Date().toISOString(),
    };

    await this.adapter.saveCheckpoint(checkpoint);
    return checkpoint;
  }

  public async deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void> {
    await this.adapter.deleteCheckpoint(migrationRunId, sourceObject);
  }
}
