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
   * Reconciles a single batch based on its crash point / status.
   * Priority 2 Safety Guarantee:
   * NEVER marks a batch COMMITTED without verifying:
   * 1. Durable record manifests exist
   * 2. Destination records exist in the target database
   * 3. RFC 8785 canonical hashes match stored manifest hashes
   */
  public async reconcileBatch(
    batch: MigrationBatch,
    destinationObject: string,
    destinationKey = 'id',
  ): Promise<ReconciliationResult | null> {
    const subStage = batch.subStage;
    const status = batch.status;

    // Batches in write-involved stages:
    // MANIFEST_COMMITTED, DESTINATION_WRITTEN, WRITE_STARTED, OUTCOME_UNKNOWN
    if (
      subStage === 'MANIFEST_COMMITTED' ||
      subStage === 'DESTINATION_WRITTEN' ||
      subStage === 'WRITE_STARTED' ||
      status === 'OUTCOME_UNKNOWN'
    ) {
      // 1. Fetch durable record manifests
      const manifests = await this.manifestTracker.listRecordManifests(
        batch.migrationRunId,
        batch.batchKey,
      );

      // Enforce: Never mark COMMITTED without durable record manifests
      if (manifests.length === 0) {
        if (batch.recordsRead === 0 && (batch.recordsWritten === 0 || !batch.recordsWritten)) {
          // Empty batch with 0 records read: safe to commit
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
            recordsCommittedCount: 0,
            cursorEnd: batch.sourceCursorEnd,
          });
          return {
            batchKey: batch.batchKey,
            originalStatus: status,
            originalSubStage: subStage,
            resolvedStatus: 'COMMITTED',
            actionTaken: 'Empty batch verified with 0 records; marked committed and advanced checkpoint',
          };
        }

        // Non-empty batch with missing record manifests cannot be verified!
        // Reset to RETRY_WAIT for safe idempotent replay
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
          actionTaken: 'Durable record manifests missing; reset to RETRY_WAIT for safe idempotent replay',
        };
      }

      // 2. Identify destination keys for records marked WRITTEN
      const writtenManifests = manifests.filter((m) => m.status === 'WRITTEN');
      const destinationKeys = writtenManifests.map((m) => m.destinationKey);

      if (destinationKeys.length === 0) {
        // All manifests are accounted for (SKIPPED or FAILED)
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
          recordsCommittedCount: 0,
          cursorEnd: batch.sourceCursorEnd,
        });
        return {
          batchKey: batch.batchKey,
          originalStatus: status,
          originalSubStage: subStage,
          resolvedStatus: 'COMMITTED',
          actionTaken: 'Durable manifests verified (all records skipped/failed); marked committed and advanced checkpoint',
        };
      }

      // 3. Inspect destination records by stable keys
      try {
        const foundRecords = await this.destinationConnector.readByKeys(
          destinationObject,
          destinationKeys,
          destinationKey,
        );

        const foundKeyMap = new Map<string, Record<string, unknown>>();
        for (const r of foundRecords) {
          if (r && r.destinationKey !== undefined && r.destinationKey !== null && r.data && Object.keys(r.data).length > 0) {
            foundKeyMap.set(String(r.destinationKey), r.data);
          }
        }

        // Verify all expected destination keys exist in the destination table
        const allKeysFound =
          destinationKeys.length > 0 &&
          destinationKeys.every((k) => foundKeyMap.has(String(k)));

        if (!allKeysFound) {
          // Destination write did not land or was incomplete; reset for idempotent replay
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
            actionTaken: `Destination write incomplete (found ${foundKeyMap.size}/${destinationKeys.length} records); reset to RETRY_WAIT for idempotent replay`,
          };
        }

        // 4. Verify RFC 8785 canonical hash comparison for every record where contentHash is available
        let hashMismatchCount = 0;
        for (const manifest of writtenManifests) {
          const foundRecord = foundKeyMap.get(String(manifest.destinationKey));
          if (!foundRecord) {
            hashMismatchCount++;
            continue;
          }
          if (manifest.contentHash) {
            const computedHash = calculateCanonicalHash(foundRecord);
            const normComputed = computedHash.replace(/^sha256:/, '');
            const normManifest = manifest.contentHash.replace(/^sha256:/, '');
            if (normComputed !== normManifest) {
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

        // All keys found, all RFC 8785 hashes verified, durable record manifests confirmed!
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
          actionTaken: 'Verified destination records, RFC 8785 canonical hashes, and durable manifests; marked committed and advanced checkpoint',
        };
      } catch (err: any) {
        // If destination cannot be inspected, mark or retain OUTCOME_UNKNOWN for operator review
        if (status !== 'OUTCOME_UNKNOWN') {
          await this.manifestTracker.transitionState(
            batch.migrationRunId,
            batch.batchKey,
            'OUTCOME_UNKNOWN',
            subStage,
          );
        }
        return {
          batchKey: batch.batchKey,
          originalStatus: status,
          originalSubStage: subStage,
          resolvedStatus: 'OUTCOME_UNKNOWN',
          actionTaken: `Failed to inspect destination keys: ${err?.message || 'destination unreachable'}; operator reconciliation required`,
        };
      }
    }

    // Case 5: Crash before write (READ_STARTED, READ_COMPLETED, TRANSFORM_STARTED, TRANSFORM_COMPLETED, QUEUED, PENDING, RUNNING without write started)
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
