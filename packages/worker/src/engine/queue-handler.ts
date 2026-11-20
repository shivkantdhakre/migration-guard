/**
 * Queue Message Handling via BullMQ / Redis
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md (Section 4), 08_MIGRATION_ENGINE_DESIGN.md, FR-EXEC-002
 *
 * CRITICAL ARCHITECTURAL CONSTRAINT:
 * Queue payloads carry IDs and cursors only, NEVER bulk records!
 */

import {
  BatchStatus,
  DestinationConnector,
  MigrationBatch,
  MigrationJobPayload,
  SourceConnector,
  SourceRecordEnvelope,
  TransformedBatch,
  TransformedRecord,
  TransformFunction,
  WriteResult,
} from '../types.js';
import { BatchManifestTracker } from './batch-manifest.js';
import { CheckpointManager } from './checkpoint.js';
import { DestinationWriter } from './destination-writer.js';
import { ErrorClassifier } from './error-classifier.js';
import { IdTracker } from './id-tracker.js';

export interface QueueHandlerConfig {
  sourceConnector: SourceConnector;
  destinationConnector: DestinationConnector;
  manifestTracker: BatchManifestTracker;
  checkpointManager: CheckpointManager;
  idTracker?: IdTracker;
  transformFn?: TransformFunction;
  onNextBatchScheduled?: (payload: MigrationJobPayload) => Promise<void> | void;
}

export interface JobExecutionResult {
  migrationRunId: string;
  batchKey: string;
  sequenceNo: number;
  status: BatchStatus;
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  hasMore: boolean;
  nextPayload?: MigrationJobPayload;
  error?: unknown;
}

export class QueueHandler {
  private sourceConnector: SourceConnector;
  private destinationConnector: DestinationConnector;
  private manifestTracker: BatchManifestTracker;
  private checkpointManager: CheckpointManager;
  private idTracker?: IdTracker;
  private destinationWriter: DestinationWriter;
  private transformFn: TransformFunction;
  private onNextBatchScheduled?: (payload: MigrationJobPayload) => Promise<void> | void;

  constructor(config: QueueHandlerConfig) {
    this.sourceConnector = config.sourceConnector;
    this.destinationConnector = config.destinationConnector;
    this.manifestTracker = config.manifestTracker;
    this.checkpointManager = config.checkpointManager;
    this.idTracker = config.idTracker;
    this.onNextBatchScheduled = config.onNextBatchScheduled;

    this.destinationWriter = new DestinationWriter({
      connector: config.destinationConnector,
      idTracker: config.idTracker,
      manifestTracker: config.manifestTracker,
    });

    this.transformFn = config.transformFn ?? this.defaultPassThroughTransform;
  }

  /**
   * Strictly validates that the queue payload contains ONLY identifiers, cursors, and metadata.
   * Throws an error if any bulk record payload is detected.
   */
  public static validatePayload(
    payload: unknown,
    options?: { requireConnections?: boolean },
  ): asserts payload is MigrationJobPayload {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Queue payload must be a non-null object');
    }

    const p = payload as Record<string, unknown>;

    // Forbidden keys that would indicate bulk data transport
    const forbiddenKeys = [
      'records',
      'bulkData',
      'rows',
      'documents',
      'payloadData',
      'items',
      'data',
    ];

    for (const forbidden of forbiddenKeys) {
      if (forbidden in p) {
        throw new Error(
          `Architectural violation (FR-EXEC-002): Queue payloads must NEVER carry bulk records! Found key: '${forbidden}'`,
        );
      }
    }

    // Required fields check
    const required = [
      'jobId',
      'migrationRunId',
      'batchKey',
      'sequenceNo',
      'sourceObject',
      'destinationObject',
      'batchSize',
      'planVersionId',
      'mappingVersionId',
      'writeMode',
    ];

    for (const req of required) {
      if (p[req] === undefined || p[req] === null) {
        throw new Error(`Queue payload missing required property: ${req}`);
      }
    }

    // P0.4: Require source and destination connection IDs for all production migration jobs
    const requireConnections =
      options?.requireConnections ??
      (process.env.NODE_ENV === 'production' || process.env.REQUIRE_CONNECTION_IDS === 'true');

    if (requireConnections) {
      if (!p.sourceConnectionId || typeof p.sourceConnectionId !== 'string') {
        throw new Error('Queue payload missing required property: sourceConnectionId');
      }
      if (!p.destinationConnectionId || typeof p.destinationConnectionId !== 'string') {
        throw new Error('Queue payload missing required property: destinationConnectionId');
      }
    }

    // Validate writeMode
    const validModes = ['insert_only', 'upsert', 'skip_existing'];
    const mode = typeof p.writeMode === 'string' ? p.writeMode.toLowerCase() : '';
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid writeMode in payload: ${p.writeMode}`);
    }
    p.writeMode = mode as any;
  }

  /**
   * Process a single migration job from queue
   */
  public async processJob(rawPayload: unknown): Promise<JobExecutionResult> {
    // 1. Validate payload compliance with FR-EXEC-002
    QueueHandler.validatePayload(rawPayload);
    const payload = rawPayload as MigrationJobPayload;

    // 2. Load or create batch manifest
    let batch = await this.manifestTracker.getBatch(payload.migrationRunId, payload.batchKey);
    if (!batch) {
      batch = await this.manifestTracker.createBatch({
        migrationRunId: payload.migrationRunId,
        batchKey: payload.batchKey,
        sequenceNo: payload.sequenceNo,
        sourceObject: payload.sourceObject,
        destinationObject: payload.destinationObject,
        sourceCursorStart: payload.cursorStart,
      });
    }

    // Check if batch was already committed (idempotent resume after crash)
    if (batch.status === 'COMMITTED') {
      return {
        migrationRunId: payload.migrationRunId,
        batchKey: payload.batchKey,
        sequenceNo: payload.sequenceNo,
        status: 'COMMITTED',
        recordsRead: batch.recordsRead,
        recordsWritten: batch.recordsWritten,
        recordsSkipped: batch.recordsSkipped,
        recordsFailed: batch.recordsFailed,
        hasMore: false,
      };
    }

    // 3. Transition to RUNNING
    await this.manifestTracker.transitionState(
      payload.migrationRunId,
      payload.batchKey,
      'RUNNING',
      'READ_STARTED',
    );

    try {
      // 4. Read bounded batch using connector
      const sourceBatch = await this.sourceConnector.readBatch(payload.cursorStart, {
        sourceObject: payload.sourceObject,
        batchSize: payload.batchSize,
        maxBytes: payload.maxBytes,
      });

      const records = sourceBatch.records || [];
      const recordsRead = records.length;
      const cursorEnd = sourceBatch.nextCursor;

      await this.manifestTracker.updateCounters(payload.migrationRunId, payload.batchKey, {
        recordsRead,
        sourceCursorEnd: cursorEnd,
      });

      await this.manifestTracker.updateSubStage(
        payload.migrationRunId,
        payload.batchKey,
        'READ_COMPLETED',
      );

      // Handle empty batch
      if (recordsRead === 0) {
        await this.manifestTracker.transitionState(
          payload.migrationRunId,
          payload.batchKey,
          'COMMITTED',
          'CHECKPOINT_COMMITTED',
        );

        return {
          migrationRunId: payload.migrationRunId,
          batchKey: payload.batchKey,
          sequenceNo: payload.sequenceNo,
          status: 'COMMITTED',
          recordsRead: 0,
          recordsWritten: 0,
          recordsSkipped: 0,
          recordsFailed: 0,
          hasMore: false,
        };
      }

      // 5. Transform records
      await this.manifestTracker.updateSubStage(
        payload.migrationRunId,
        payload.batchKey,
        'TRANSFORM_STARTED',
      );

      const transformedRecords: TransformedRecord[] = [];
      for (const env of records) {
        const transformed = await this.transformFn(env);
        if (transformed) {
          transformedRecords.push(transformed);
        }
      }

      await this.manifestTracker.updateSubStage(
        payload.migrationRunId,
        payload.batchKey,
        'TRANSFORM_COMPLETED',
      );

      // 6. Write to destination idempotently
      const transformedBatch: TransformedBatch = {
        destinationObject: payload.destinationObject,
        batchKey: payload.batchKey,
        records: transformedRecords,
      };

      const writeResult: WriteResult = await this.destinationWriter.write(transformedBatch, {
        migrationRunId: payload.migrationRunId,
        sourceObject: payload.sourceObject,
        writeMode: payload.writeMode,
        conflictColumns: payload.conflictColumns,
        updateColumns: payload.updateColumns,
      });

      await this.manifestTracker.updateCounters(payload.migrationRunId, payload.batchKey, {
        recordsWritten: writeResult.recordsWritten,
        recordsSkipped: writeResult.recordsSkipped,
        recordsFailed: writeResult.recordsFailed,
      });

      // Strict failure check: If any records failed to write, do NOT commit the batch.
      // Throw an error so the failure classifier transitions the batch to FAILED_* and BullMQ retries/fails.
      if (writeResult.recordsFailed > 0) {
        const firstErr = writeResult.failedKeys?.[0];
        const errMsg = firstErr ? `(Key: ${firstErr.key}, Error: ${firstErr.error})` : 'Destination write rejected records';
        throw new Error(
          `Destination write failed for ${writeResult.recordsFailed} of ${transformedRecords.length} records in batch ${payload.batchKey} ${errMsg}`,
        );
      }

      // 7. Advance checkpoint
      batch = (await this.manifestTracker.getBatch(payload.migrationRunId, payload.batchKey))!;
      await this.checkpointManager.advanceCheckpoint({
        migrationRunId: payload.migrationRunId,
        sourceObject: payload.sourceObject,
        batch,
        planVersionId: payload.planVersionId,
        mappingVersionId: payload.mappingVersionId,
        recordsCommittedCount: writeResult.recordsWritten,
        cursorEnd,
      });

      // 8. Commit batch manifest
      await this.manifestTracker.transitionState(
        payload.migrationRunId,
        payload.batchKey,
        'COMMITTED',
        'CHECKPOINT_COMMITTED',
      );

      // 9. Schedule next batch if more records exist
      let nextPayload: MigrationJobPayload | undefined;
      const hasMore = sourceBatch.hasMore && cursorEnd !== null;

      if (hasMore) {
        const nextSequence = payload.sequenceNo + 1;
        const nextBatchKey = `batch_${payload.sourceObject}_seq_${String(nextSequence).padStart(6, '0')}`;
        nextPayload = {
          jobId: `job_${payload.migrationRunId}_${nextBatchKey}`,
          migrationRunId: payload.migrationRunId,
          batchKey: nextBatchKey,
          sequenceNo: nextSequence,
          sourceObject: payload.sourceObject,
          destinationObject: payload.destinationObject,
          cursorStart: cursorEnd,
          batchSize: payload.batchSize,
          maxBytes: payload.maxBytes,
          planVersionId: payload.planVersionId,
          mappingVersionId: payload.mappingVersionId,
          writeMode: payload.writeMode,
          conflictColumns: payload.conflictColumns,
          updateColumns: payload.updateColumns,
        };

        if (this.onNextBatchScheduled) {
          await this.onNextBatchScheduled(nextPayload);
        }
      }

      return {
        migrationRunId: payload.migrationRunId,
        batchKey: payload.batchKey,
        sequenceNo: payload.sequenceNo,
        status: 'COMMITTED',
        recordsRead,
        recordsWritten: writeResult.recordsWritten,
        recordsSkipped: writeResult.recordsSkipped,
        recordsFailed: writeResult.recordsFailed,
        hasMore,
        nextPayload,
      };
    } catch (err: unknown) {
      // 10. Handle errors with classification
      const currentBatch = await this.manifestTracker.getBatch(payload.migrationRunId, payload.batchKey);
      const subStage = currentBatch?.subStage || 'READ_STARTED';

      const classified = ErrorClassifier.classify(err, subStage);
      const attemptCount = (currentBatch?.attemptCount || 1);
      const maxAttempts = currentBatch?.maxAttempts || 3;
      const errorSummary = ErrorClassifier.toErrorSummary(classified, attemptCount);

      let targetStatus: BatchStatus = 'FAILED_PERMANENT';

      if (classified.classification === 'OUTCOME_UNKNOWN') {
        targetStatus = 'OUTCOME_UNKNOWN';
      } else if (classified.isRetryable) {
        if (attemptCount < maxAttempts) {
          targetStatus = 'RETRY_WAIT';
        } else {
          targetStatus = 'FAILED_RETRYABLE';
        }
      } else {
        targetStatus = 'FAILED_PERMANENT';
      }

      await this.manifestTracker.transitionState(
        payload.migrationRunId,
        payload.batchKey,
        targetStatus,
        subStage,
        errorSummary,
      );

      return {
        migrationRunId: payload.migrationRunId,
        batchKey: payload.batchKey,
        sequenceNo: payload.sequenceNo,
        status: targetStatus,
        recordsRead: currentBatch?.recordsRead || 0,
        recordsWritten: currentBatch?.recordsWritten || 0,
        recordsSkipped: currentBatch?.recordsSkipped || 0,
        recordsFailed: currentBatch?.recordsFailed || 0,
        hasMore: false,
        error: err,
      };
    }
  }

  private defaultPassThroughTransform(envelope: SourceRecordEnvelope): TransformedRecord {
    const rawPayload = (envelope.payload && typeof envelope.payload === 'object')
      ? (envelope.payload as Record<string, unknown>)
      : { value: envelope.payload };

    return {
      destinationKey: envelope.sourceKey,
      sourceKey: envelope.sourceKey,
      sourceObject: envelope.sourceObject,
      destinationObject: envelope.sourceObject,
      data: {
        id: envelope.sourceKey,
        ...rawPayload,
      },
      originalEnvelope: envelope,
    };
  }
}
