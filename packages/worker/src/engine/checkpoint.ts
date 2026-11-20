/**
 * Migration Checkpoint Manager
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md (Section 10), 08_MIGRATION_ENGINE_DESIGN.md (Section 9), FR-REC-001
 *
 * Manages durable checkpoints representing the highest source cursor/range
 * whose destination effects and batch manifests are durable.
 * Advance only after destination writes and record manifests have succeeded.
 */

import { MigrationBatch, MigrationCheckpoint, SourceCursor } from '../types.js';

export interface CheckpointAdvanceParams {
  migrationRunId: string;
  sourceObject: string;
  batch: MigrationBatch;
  planVersionId: string;
  mappingVersionId: string;
  recordsCommittedCount: number;
  cursorEnd: SourceCursor | null;
}

export interface CheckpointStorageAdapter {
  saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void>;
  getCheckpoint(migrationRunId: string, sourceObject: string): Promise<MigrationCheckpoint | null>;
  deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void>;
  advanceCheckpoint?(params: CheckpointAdvanceParams): Promise<MigrationCheckpoint>;
}

/**
 * Pure helper function to merge a batch commit into a checkpoint state.
 * Handles out-of-order commits, high-water mark progression, and idempotent replays.
 */
export function mergeCheckpointUpdate(
  current: MigrationCheckpoint | null,
  params: CheckpointAdvanceParams,
): MigrationCheckpoint {
  // Track committed sequence numbers
  const committedSequences = new Set<number>(current?.committedSequences || []);
  if (current?.lastCommittedSequenceNo && current.lastCommittedSequenceNo > 0) {
    committedSequences.add(current.lastCommittedSequenceNo);
  }

  // Check if this is an illegal regression on an already-committed sequence number
  if (
    current &&
    current.sourceObject === params.sourceObject &&
    params.batch.sequenceNo < current.lastCommittedSequenceNo &&
    committedSequences.has(params.batch.sequenceNo)
  ) {
    throw new Error(
      `Cannot regress checkpoint sequence for ${params.sourceObject}: current is ${current.lastCommittedSequenceNo}, attempted ${params.batch.sequenceNo}`,
    );
  }

  // Idempotency check: if this sequence was already committed, do not double-count records
  const alreadyCommitted = committedSequences.has(params.batch.sequenceNo);

  // Add this batch's sequence number to the committed set
  committedSequences.add(params.batch.sequenceNo);

  // Track entries for cursorEnd and batchKey by sequence number
  const committedEntries: Record<number, { batchKey: string; cursorEnd: SourceCursor | null }> = {
    ...(current?.committedEntries || {}),
  };
  if (current && current.lastCommittedSequenceNo > 0 && !committedEntries[current.lastCommittedSequenceNo]) {
    committedEntries[current.lastCommittedSequenceNo] = {
      batchKey: current.lastCommittedBatchKey,
      cursorEnd: current.lastCommittedCursor,
    };
  }
  committedEntries[params.batch.sequenceNo] = {
    batchKey: params.batch.batchKey,
    cursorEnd: params.cursorEnd,
  };

  // Determine baseSequenceNo for this entity
  let baseSeq = current?.baseSequenceNo;
  const isFirstBatch =
    !params.batch.sourceCursorStart ||
    (typeof params.batch.sourceCursorStart === 'object' &&
      ((params.batch.sourceCursorStart as any).offset === 0 || !(params.batch.sourceCursorStart as any).offset));

  if (isFirstBatch || baseSeq === undefined) {
    if (isFirstBatch) {
      baseSeq = params.batch.sequenceNo;
    } else if (baseSeq === undefined) {
      // If sequence 2 arrives before sequence 1, baseSeq starts at 1
      baseSeq = 1;
    }
  }

  // Advance high-water mark across contiguous committed sequences starting from baseSeq
  let highestContiguous = current?.lastCommittedSequenceNo || 0;
  if (baseSeq !== undefined && committedSequences.has(baseSeq)) {
    let s = baseSeq;
    while (committedSequences.has(s)) {
      highestContiguous = s;
      s++;
    }
  }

  const targetSeq = Math.max(highestContiguous, current?.lastCommittedSequenceNo || 0);
  const targetEntry = committedEntries[targetSeq] || {
    batchKey: targetSeq > 0 ? params.batch.batchKey : '',
    cursorEnd: targetSeq > 0 ? params.cursorEnd : null,
  };

  // Only increment record count if this batch was not previously committed (P0.1)
  const recordsToAdd = alreadyCommitted ? 0 : params.recordsCommittedCount;
  const totalRecordsCommitted = (current?.totalRecordsCommitted ?? 0) + recordsToAdd;

  return {
    migrationRunId: params.migrationRunId,
    sourceObject: params.sourceObject,
    lastCommittedSequenceNo: targetSeq,
    lastCommittedBatchKey: targetEntry.batchKey,
    lastCommittedCursor: targetEntry.cursorEnd,
    planVersionId: params.planVersionId,
    mappingVersionId: params.mappingVersionId,
    totalRecordsCommitted,
    updatedAt: new Date().toISOString(),
    baseSequenceNo: baseSeq,
    committedSequences: Array.from(committedSequences).sort((a, b) => a - b),
    committedEntries,
  };
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

  public async advanceCheckpoint(params: CheckpointAdvanceParams): Promise<MigrationCheckpoint> {
    const current = await this.getCheckpoint(params.migrationRunId, params.sourceObject);
    const updated = mergeCheckpointUpdate(current, params);
    await this.saveCheckpoint(updated);
    return updated;
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
   * If the storage adapter provides atomic advanceCheckpoint, delegates to it
   * (e.g. PostgresStorageAdapter runs within a SELECT ... FOR UPDATE transaction).
   */
  public async advanceCheckpoint(params: CheckpointAdvanceParams): Promise<MigrationCheckpoint> {
    if (typeof this.adapter.advanceCheckpoint === 'function') {
      return this.adapter.advanceCheckpoint(params);
    }

    const current = await this.getCheckpoint(params.migrationRunId, params.sourceObject);
    const updated = mergeCheckpointUpdate(current, params);
    await this.adapter.saveCheckpoint(updated);
    return updated;
  }

  public async deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void> {
    await this.adapter.deleteCheckpoint(migrationRunId, sourceObject);
  }
}
