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

    // 1. Deduplicate records within batch by destinationKey (in-batch idempotency guard)
    const dedupedRecords = this.deduplicateRecords(batch.records);
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
    } catch (err) {
      // Classify error with WRITE_STARTED subStage so network timeouts are marked OUTCOME_UNKNOWN
      const classified = ErrorClassifier.classify(err, 'WRITE_STARTED');
      throw Object.assign(
        new Error(`Failed to write batch ${batch.batchKey} to destination: ${classified.message}`),
        { classified, originalError: err },
      );
    }

    // 4. Mark intermediate sub-stage: DESTINATION_WRITTEN
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
        let status: 'WRITTEN' | 'SKIPPED' | 'FAILED' = 'WRITTEN';
        let error: string | undefined;

        if (writeResult.skippedKeys.includes(r.destinationKey)) {
          status = 'SKIPPED';
        } else if (writeResult.failedKeys.some((f) => f.key === r.destinationKey)) {
          status = 'FAILED';
          error = writeResult.failedKeys.find((f) => f.key === r.destinationKey)?.error;
        }

        return {
          migrationRunId: options.migrationRunId,
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
   * Deduplicate records in memory by destinationKey to avoid intra-batch primary key collisions
   */
  private deduplicateRecords(records: TransformedRecord[]): TransformedRecord[] {
    const seen = new Set<string>();
    const result: TransformedRecord[] = [];

    // Keep the latest record for each key if duplicate appears within the batch
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (!seen.has(record.destinationKey)) {
        seen.add(record.destinationKey);
        result.unshift(record);
      }
    }

    return result;
  }
}
