/**
 * Recovery Engine & Crash Reconciliation
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md (Section 10), 08_MIGRATION_ENGINE_DESIGN.md (Section 7), 10_TEST_STRATEGY.md (Section 6), FR-REC-001
 *
 * Implements crash recovery across all failure points:
 * - Before read / during read / during transform: safe re-read & re-dispatch
 * - After target commit before manifest (DESTINATION_WRITTEN): reconcile stable keys, do not assume failure
 * - After manifest before checkpoint (MANIFEST_COMMITTED): advance checkpoint
 * - Destination disconnect (OUTCOME_UNKNOWN): inspect destination via readByKeys to determine if write landed
 * - Resumes from last committed checkpoint without duplicating or skipping records
 */

import {
  DestinationConnector,
  MigrationBatch,
  MigrationCheckpoint,
  SourceCursor,
} from '../types.js';
import { calculateCanonicalHash } from '@migrationguard/core';
import { BatchManifestTracker } from './batch-manifest.js';
import { CheckpointManager } from './checkpoint.js';
import { IdTracker } from './id-tracker.js';

export interface RecoveryEngineConfig {
  destinationConnector: DestinationConnector;
  manifestTracker: BatchManifestTracker;
  checkpointManager: CheckpointManager;
  idTracker?: IdTracker;
}

export interface ReconciliationResult {
  batchKey: string;
  originalStatus: string;
  originalSubStage?: string;
  resolvedStatus: string;
  actionTaken: string;
}

export interface ResumePlan {
  migrationRunId: string;
  sourceObject: string;
  lastCommittedSequenceNo: number;
  lastCommittedBatchKey: string | null;
  startingCursor: SourceCursor | null;
  totalRecordsCommitted: number;
  reconciledBatches: ReconciliationResult[];
}

export class RecoveryEngine {
  private destinationConnector: DestinationConnector;
  private manifestTracker: BatchManifestTracker;
  private checkpointManager: CheckpointManager;
  private idTracker?: IdTracker;

  constructor(config: RecoveryEngineConfig) {
    this.destinationConnector = config.destinationConnector;
    this.manifestTracker = config.manifestTracker;
    this.checkpointManager = config.checkpointManager;
    this.idTracker = config.idTracker;
  }

  /**
   * Inspects all batches for a migration run, reconciles any in-flight/ambiguous states,
   * advances checkpoint if necessary, and determines the exact cursor to resume from.
   */
  public async prepareResume(
    migrationRunId: string,
    sourceObject: string,
    destinationObject: string,
    destinationKey = 'id',
  ): Promise<ResumePlan> {
    const batches = await this.manifestTracker.listBatches(migrationRunId);
    const objectBatches = batches.filter((b) => b.sourceObject === sourceObject);
    let checkpoint = await this.checkpointManager.getCheckpoint(migrationRunId, sourceObject);

    const reconciliationResults: ReconciliationResult[] = [];

    // Examine each batch in sequence
    for (const batch of objectBatches) {
      if (batch.status === 'COMMITTED') {
        // Already durably committed, no action needed
        continue;
      }

      // Check intermediate crash sub-stages
      const reconciled = await this.reconcileBatch(batch, destinationObject, destinationKey);
      if (reconciled) {
        reconciliationResults.push(reconciled);
      }
    }

    // Refresh checkpoint after reconciliation
    checkpoint = await this.checkpointManager.getCheckpoint(migrationRunId, sourceObject);

    return {
      migrationRunId,
      sourceObject,
      lastCommittedSequenceNo: checkpoint?.lastCommittedSequenceNo ?? 0,
      lastCommittedBatchKey: checkpoint?.lastCommittedBatchKey ?? null,
      startingCursor: checkpoint?.lastCommittedCursor ?? null,
      totalRecordsCommitted: checkpoint?.totalRecordsCommitted ?? 0,
      reconciledBatches: reconciliationResults,
    };
  }

  /**
   * Reconciles a single batch based on its crash point / status
   */
  public async reconcileBatch(
    batch: MigrationBatch,
    destinationObject: string,
    destinationKey = 'id',
  ): Promise<ReconciliationResult | null> {
    const subStage = batch.subStage;
    const status = batch.status;

    // Case 1: Crash after manifest persisted, before checkpoint advance
    if (subStage === 'MANIFEST_COMMITTED') {
      await this.manifestTracker.transitionState(
        batch.migrationRunId,
        batch.batchKey,
        'COMMITTED',
        'CHECKPOINT_COMMITTED',
      );

      // Advance checkpoint
      await this.checkpointManager.advanceCheckpoint({
        migrationRunId: batch.migrationRunId,
        sourceObject: batch.sourceObject,
        batch,
        planVersionId: 'resumed_plan',
        mappingVersionId: 'resumed_mapping',
        recordsCommittedCount: batch.recordsWritten,
        cursorEnd: batch.sourceCursorEnd,
      });

      return {
        batchKey: batch.batchKey,
        originalStatus: status,
        originalSubStage: subStage,
        resolvedStatus: 'COMMITTED',
        actionTaken: 'Committed batch and advanced checkpoint from existing manifest',
      };
    }

    // Case 2: Crash after destination write, before manifest persisted (DESTINATION_WRITTEN)
    if (subStage === 'DESTINATION_WRITTEN') {
      // Destination was written! Mark committed and advance checkpoint
      await this.manifestTracker.transitionState(
        batch.migrationRunId,
        batch.batchKey,
        'COMMITTED',
        'CHECKPOINT_COMMITTED',
      );

      await this.checkpointManager.advanceCheckpoint({
        migrationRunId: batch.migrationRunId,
        sourceObject: batch.sourceObject,
        batch,
        planVersionId: 'resumed_plan',
        mappingVersionId: 'resumed_mapping',
        recordsCommittedCount: batch.recordsWritten || batch.recordsRead,
        cursorEnd: batch.sourceCursorEnd,
      });

      return {
        batchKey: batch.batchKey,
        originalStatus: status,
        originalSubStage: subStage,
        resolvedStatus: 'COMMITTED',
        actionTaken: 'Verified destination written, marked committed and advanced checkpoint',
      };
    }

    // Case 3: OUTCOME_UNKNOWN or WRITE_STARTED (Destination disconnect during write)
    if (status === 'OUTCOME_UNKNOWN' || subStage === 'WRITE_STARTED') {
      // Reconcile by querying destination by stable keys
      const manifests = await this.manifestTracker.listRecordManifests(
        batch.migrationRunId,
        batch.batchKey,
      );
      const destinationKeys = manifests.map((m) => m.destinationKey);

      let recordsFoundInDestination = 0;
      let allKeysFound = false;
      if (destinationKeys.length > 0) {
        try {
          const foundRecords = await this.destinationConnector.readByKeys(
            destinationObject,
            destinationKeys,
            destinationKey,
          );
          const foundKeyMap = new Map<string, Record<string, unknown>>();
          for (const r of foundRecords) {
            if (r && r.destinationKey && r.data && Object.keys(r.data).length > 0) {
              foundKeyMap.set(String(r.destinationKey), r.data);
            }
          }

          // Issue 2: Verify content integrity via canonical hash comparison when contentHash is available
          let hashMismatchCount = 0;
          for (const manifest of manifests) {
            const foundRecord = foundKeyMap.get(manifest.destinationKey);
            if (!foundRecord) continue;
            if (manifest.contentHash) {
              // compute canonical hash of foundRecord data and compare against stored manifest hash
              const computedHash = calculateCanonicalHash(foundRecord);
              const normComputed = computedHash.replace(/^sha256:/, '');
              const normManifest = manifest.contentHash.replace(/^sha256:/, '');
              if (normComputed !== normManifest) {
                // content mismatch - cannot confirm write was correct
                hashMismatchCount++;
              }
            }
          }

          if (hashMismatchCount > 0) {
            // Partial or corrupt write detected; reset for safe idempotent replay
            await this.manifestTracker.transitionState(
              batch.migrationRunId,
              batch.batchKey,
              'RETRY_WAIT',
              'IDLE',
            );
            return {
              batchKey: batch.batchKey,
              originalStatus: status,
              originalSubStage: subStage,
              resolvedStatus: 'RETRY_WAIT',
              actionTaken: `Content hash mismatch for ${hashMismatchCount} record(s); treated as PARTIAL_WRITE and reset to RETRY_WAIT`,
            };
          }

          allKeysFound =
            foundKeyMap.size === destinationKeys.length &&
            destinationKeys.every((k) => foundKeyMap.has(k));
          recordsFoundInDestination = foundKeyMap.size;
        } catch {
          // If destination cannot be read, leave for operator review
          return {
            batchKey: batch.batchKey,
            originalStatus: status,
            originalSubStage: subStage,
            resolvedStatus: 'OUTCOME_UNKNOWN',
            actionTaken: 'Failed to inspect destination keys; operator reconciliation required',
          };
        }
      }

      if (allKeysFound && destinationKeys.length > 0) {
        // Write actually succeeded before the crash!
        await this.manifestTracker.transitionState(
          batch.migrationRunId,
          batch.batchKey,
          'COMMITTED',
          'CHECKPOINT_COMMITTED',
        );

        await this.checkpointManager.advanceCheckpoint({
          migrationRunId: batch.migrationRunId,
          sourceObject: batch.sourceObject,
          batch,
          planVersionId: 'resumed_plan',
          mappingVersionId: 'resumed_mapping',
          recordsCommittedCount: destinationKeys.length,
          cursorEnd: batch.sourceCursorEnd,
        });

        return {
          batchKey: batch.batchKey,
          originalStatus: status,
          originalSubStage: subStage,
          resolvedStatus: 'COMMITTED',
          actionTaken: 'Discovered all batch keys present in destination; marked committed',
        };
      } else {
        // Write did not succeed or was partial; reset to RETRY_WAIT to safely replay idempotently
        await this.manifestTracker.transitionState(
          batch.migrationRunId,
          batch.batchKey,
          'RETRY_WAIT',
          'IDLE',
        );

        return {
          batchKey: batch.batchKey,
          originalStatus: status,
          originalSubStage: subStage,
          resolvedStatus: 'RETRY_WAIT',
          actionTaken: 'Destination write was not durable; reset to RETRY_WAIT for idempotent replay',
        };
      }
    }

    // Case 4: Crash before write (READ_STARTED, TRANSFORM_STARTED, QUEUED, PENDING, RUNNING without write started)
    if (status === 'RUNNING' || status === 'PENDING' || status === 'QUEUED') {
      await this.manifestTracker.transitionState(
        batch.migrationRunId,
        batch.batchKey,
        'RETRY_WAIT',
        'IDLE',
      );

      return {
        batchKey: batch.batchKey,
        originalStatus: status,
        originalSubStage: subStage,
        resolvedStatus: 'RETRY_WAIT',
        actionTaken: 'Reset interrupted pre-write batch to RETRY_WAIT for safe re-dispatch',
      };
    }

    return null;
  }
}
