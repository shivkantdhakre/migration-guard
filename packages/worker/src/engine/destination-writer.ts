/**
 * Destination Writer with Idempotent Insert-Only, Upsert, and Skip-Existing Modes
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 08_MIGRATION_ENGINE_DESIGN.md (Section 6 & 7), FR-EXEC-006
 *
 * Implements deterministic destination writing with idempotency guarantees:
 * - Insert-only: Fails if destination key already exists.
 * - Upsert: Merges/updates on conflict using stable keys and explicit update columns.
 * - Skip-existing: Bypasses already existing keys and tracks skipped status.
 *
 * Automatically deduplicates in-batch records by stable destination key to prevent self-collision.
 */

import {
  DestinationConnector,
  TransformedBatch,
  TransformedRecord,
  WriteMode,
  WriteOptions,
  WriteResult,
} from '../types.js';
import { BatchManifestTracker } from './batch-manifest.js';
import { ErrorClassifier } from './error-classifier.js';
import { IdTracker } from './id-tracker.js';

export interface DestinationWriterConfig {
  connector: DestinationConnector;
  idTracker?: IdTracker;
  manifestTracker?: BatchManifestTracker;
}

export interface ExecuteWriteOptions extends WriteOptions {
  migrationRunId: string;
  migrationBatchId?: string;
  sourceObject: string;
}

export class DestinationWriter {
  private connector: DestinationConnector;
  private idTracker?: IdTracker;
  private manifestTracker?: BatchManifestTracker;

  constructor(config: DestinationWriterConfig) {
    this.connector = config.connector;
    this.idTracker = config.idTracker;
    this.manifestTracker = config.manifestTracker;
  }

  /**
   * Writes a batch of transformed records to the destination connector idempotently.
   */
  public async write(
    batch: TransformedBatch,
    options: ExecuteWriteOptions,
  ): Promise<WriteResult> {
    const startTime = Date.now();

    // 0. Validate destination payloads: reject empty destination payloads
    for (const r of batch.records) {
      if (!r.data || typeof r.data !== 'object' || Object.keys(r.data).length === 0) {
        throw Object.assign(
          new Error(`Record with destinationKey '${r.destinationKey}' produced an empty destination payload`),
          { code: 'EMPTY_DESTINATION_PAYLOAD' },
        );
      }
    }

    // 1. Deduplicate records within batch by destinationKey (in-batch idempotency guard)
    // Detect collisions where different source records map to the same destination key
    const dedupedRecords = this.deduplicateRecords(batch.records);

    // Cross-batch collision detection: detect if destinationKey was already mapped to a different sourceKey in this migration run
    if (this.idTracker) {
      for (const r of dedupedRecords) {
        const existingSourceKey = await this.idTracker.getSourceKey(
          options.migrationRunId,
          batch.destinationObject,
          r.destinationKey,
        );
        if (existingSourceKey && existingSourceKey !== r.sourceKey) {
          throw Object.assign(
            new Error(
              `Collision detected: distinct source record '${r.sourceKey}' maps to destinationKey '${r.destinationKey}' ` +
                `which was already written by source record '${existingSourceKey}' in migration run '${options.migrationRunId}'.`,
            ),
            { code: 'COLLISION_DETECTED' },
          );
        }
      }
    }

    const sanitizedBatch: TransformedBatch = {
      destinationObject: batch.destinationObject,
      batchKey: batch.batchKey,
      records: dedupedRecords,
    };

    // 2. Mark intermediate sub-stage: WRITE_STARTED
    if (this.manifestTracker) {
      try {
        await this.manifestTracker.updateSubStage(
          options.migrationRunId,
          batch.batchKey,
          'WRITE_STARTED',
        );
      } catch {
        // Non-blocking if manifest already in compatible state
      }
    }

    // 3. Execute write against destination connector
    let writeResult: WriteResult;
    try {
      writeResult = await this.connector.writeBatch(sanitizedBatch, {
        writeMode: options.writeMode,
        conflictColumns: options.conflictColumns || ['id'],
        updateColumns: options.updateColumns,
      });
    } catch (err: any) {
      // Classify error with WRITE_STARTED subStage so network timeouts are marked OUTCOME_UNKNOWN
      const classified = ErrorClassifier.classify(err, 'WRITE_STARTED');
      const wrapped = new Error(`Failed to write batch ${batch.batchKey} to destination: ${classified.message}`);
      throw Object.assign(wrapped, {
        code: classified.code || err?.code,
        sqlState: err?.sqlState || err?.code || classified.code,
        classified,
        originalError: err?.originalError || err,
      });
    }

    // 4. Mark intermediate sub-stage: DESTINATION_WRITTEN
    // Convert every unconfirmed write into a counted failure so QueueHandler cannot advance checkpoints or commit the batch
    const unconfirmedRecords = sanitizedBatch.records.filter(
      (r) =>
        !writeResult.writtenKeys.includes(r.destinationKey) &&
        !writeResult.skippedKeys.includes(r.destinationKey) &&
        !writeResult.failedKeys.some((f) => f.key === r.destinationKey),
    );

    if (unconfirmedRecords.length > 0) {
      for (const u of unconfirmedRecords) {
        writeResult.failedKeys.push({
          key: u.destinationKey,
          error: `Destination connector did not confirm write for key '${u.destinationKey}'`,
        });
      }
      writeResult.recordsFailed += unconfirmedRecords.length;
    }

    if (this.manifestTracker) {
      await this.manifestTracker.updateSubStage(
        options.migrationRunId,
        batch.batchKey,
        'DESTINATION_WRITTEN',
      );
    }

    if (process.env.FAULT_INJECTION_EXIT_AFTER === 'DESTINATION_WRITTEN') {
      console.error(
        `[Fault Injection] Triggering abrupt simulated worker crash after DESTINATION_WRITTEN (batch: ${batch.batchKey})`,
      );
      process.exit(137);
    }

    // 5. Persist ID mappings for written records (FR-MAP-005)
    if (this.idTracker && writeResult.writtenKeys.length > 0) {
      const writtenKeySet = new Set(writeResult.writtenKeys);
      const mappingsToPersist = sanitizedBatch.records
        .filter((r) => writtenKeySet.has(r.destinationKey))
        .map((r) => ({
          migrationRunId: options.migrationRunId,
          sourceObject: options.sourceObject,
          sourceKey: r.sourceKey,
          destinationObject: batch.destinationObject,
          destinationKey: r.destinationKey,
        }));

      if (mappingsToPersist.length > 0) {
        await this.idTracker.recordBatchMappings(mappingsToPersist);
      }
    }

    // 6. Persist record manifests (FR-EXEC-003)
    if (this.manifestTracker) {
      const manifests = sanitizedBatch.records.map((r) => {
        let status: 'WRITTEN' | 'SKIPPED' | 'FAILED' = 'FAILED';
        let error: string | undefined;

        if (writeResult.writtenKeys.includes(r.destinationKey)) {
          status = 'WRITTEN';
        } else if (writeResult.skippedKeys.includes(r.destinationKey)) {
          status = 'SKIPPED';
        } else if (writeResult.failedKeys.some((f) => f.key === r.destinationKey)) {
          status = 'FAILED';
          error = writeResult.failedKeys.find((f) => f.key === r.destinationKey)?.error;
        } else {
          status = 'FAILED';
          error = `Destination connector did not confirm write for key '${r.destinationKey}'`;
        }

        return {
          migrationRunId: options.migrationRunId,
          migrationBatchId: options.migrationBatchId,
          batchKey: batch.batchKey,
          sourceObject: options.sourceObject,
          sourceKey: r.sourceKey,
          destinationObject: batch.destinationObject,
          destinationKey: r.destinationKey,
          contentHash: r.contentHash,
          status,
          error,
        };
      });

      await this.manifestTracker.recordManifests(manifests);

      // Mark intermediate sub-stage: MANIFEST_COMMITTED
      await this.manifestTracker.updateSubStage(
        options.migrationRunId,
        batch.batchKey,
        'MANIFEST_COMMITTED',
      );

      if (process.env.FAULT_INJECTION_EXIT_AFTER === 'MANIFEST_COMMITTED') {
        console.error(
          `[Fault Injection] Triggering abrupt simulated worker crash after MANIFEST_COMMITTED (batch: ${batch.batchKey})`,
        );
        process.exit(137);
      }
    }

    return {
      ...writeResult,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Deduplicate records in memory by destinationKey to avoid intra-batch primary key collisions.
   * Only deduplicate genuine duplicates (same sourceKey and contentHash).
   * Detect and throw on collisions where different source records map to the same destination key.
   */
  private deduplicateRecords(records: TransformedRecord[]): TransformedRecord[] {
    const seen = new Map<string, TransformedRecord>();
    const result: TransformedRecord[] = [];

    for (const record of records) {
      const existing = seen.get(record.destinationKey);
      if (existing) {
        // If different sourceKey or different contentHash, this is a collision, NOT a duplicate
        if (existing.sourceKey !== record.sourceKey || existing.contentHash !== record.contentHash) {
          throw Object.assign(
            new Error(
              `Collision detected: distinct source records map to the same destinationKey '${record.destinationKey}' ` +
                `(sourceKey: '${existing.sourceKey}' vs '${record.sourceKey}', hashes: '${existing.contentHash}' vs '${record.contentHash}')`,
            ),
            { code: 'COLLISION_DETECTED' },
          );
        }
        // Genuine duplicate: safely ignore subsequent occurrences
      } else {
        seen.set(record.destinationKey, record);
        result.push(record);
      }
    }

    return result;
  }
}
