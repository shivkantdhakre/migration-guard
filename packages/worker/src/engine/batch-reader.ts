/**
 * Bounded-Memory Streaming Batch Reader
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 08_MIGRATION_ENGINE_DESIGN.md (Section 5), FR-EXEC-002
 *
 * Implements bounded-memory streaming reads using connector adapters.
 * Never loads entire source collections/tables into memory.
 * Employs backpressure: next batch is fetched only after current batch has been processed.
 */

import {
  ReadBatchOptions,
  SourceBatch,
  SourceConnector,
  SourceCursor,
  SourceRecordEnvelope,
} from '../types.js';
import { ErrorClassifier } from './error-classifier.js';

export interface BoundedReaderOptions {
  sourceObject: string;
  batchSize?: number; // e.g. 500 records
  maxBytes?: number; // e.g. 10 * 1024 * 1024 (10MB)
  maxRecords?: number; // optional limit for testing / bounded dry runs
  sortField?: string;
  abortSignal?: AbortSignal;
}

export interface BatchReadResult {
  batchKey: string;
  sequenceNo: number;
  records: SourceRecordEnvelope[];
  cursorStart: SourceCursor | null;
  cursorEnd: SourceCursor | null;
  hasMore: boolean;
  bytesRead: number;
  recordsCount: number;
}

export class BatchReader {
  private connector: SourceConnector;

  constructor(connector: SourceConnector) {
    this.connector = connector;
  }

  /**
   * Async generator that streams batches from the source connector one page at a time.
   * Ensures bounded memory consumption: previous batch can be garbage collected
   * as the consumer processes records before yielding next page.
   */
  public async *streamBatches(
    initialCursor: SourceCursor | null,
    options: BoundedReaderOptions,
  ): AsyncGenerator<BatchReadResult, void, unknown> {
    const batchSize = options.batchSize ?? 500;
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    let currentCursor: SourceCursor | null = initialCursor ? { ...initialCursor } : null;
    let sequenceNo = 1;
    let totalRecordsRead = 0;

    while (true) {
      if (options.abortSignal?.aborted) {
        break;
      }

      // Read a single bounded page from source connector
      let batch: SourceBatch;
      try {
        const readOpts: ReadBatchOptions = {
          sourceObject: options.sourceObject,
          batchSize,
          maxBytes,
          sortField: options.sortField,
        };
        batch = await this.connector.readBatch(currentCursor, readOpts);
      } catch (err) {
        const classified = ErrorClassifier.classify(err, 'READ_STARTED');
        throw Object.assign(
          new Error(`Error reading batch ${sequenceNo} from ${options.sourceObject}: ${classified.message}`),
          { classified, originalError: err },
        );
      }

      const records = batch.records || [];
      const recordsCount = records.length;
      totalRecordsRead += recordsCount;

      const cursorStart = currentCursor ? { ...currentCursor } : null;
      const cursorEnd = batch.nextCursor ? { ...batch.nextCursor } : null;

      // Estimate batch byte size
      const bytesRead = batch.stats?.bytesRead ?? this.estimateBatchBytes(records);

      const batchKey = `batch_${options.sourceObject}_seq_${String(sequenceNo).padStart(6, '0')}`;

      // Check termination conditions
      const hasReachedMaxRecords = options.maxRecords ? totalRecordsRead >= options.maxRecords : false;
      const hasMore = batch.hasMore && recordsCount > 0 && !hasReachedMaxRecords;

      yield {
        batchKey,
        sequenceNo,
        records,
        cursorStart,
        cursorEnd,
        hasMore,
        bytesRead,
        recordsCount,
      };

      if (!hasMore || recordsCount === 0 || hasReachedMaxRecords) {
        break;
      }

      // Advance cursor for next page
      currentCursor = cursorEnd;
      sequenceNo++;
    }
  }

  /**
   * Estimate rough payload bytes for a batch of envelopes without deep serialization
   */
  private estimateBatchBytes(records: SourceRecordEnvelope[]): number {
    let bytes = 0;
    for (const r of records) {
      bytes += (r.sourceKey?.length || 10) * 2;
      bytes += (r.sourceObject?.length || 10) * 2;
      if (typeof r.payload === 'string') {
        bytes += r.payload.length * 2;
      } else if (r.payload && typeof r.payload === 'object') {
        bytes += 256; // baseline object overhead estimation
      }
    }
    return bytes;
  }
}
