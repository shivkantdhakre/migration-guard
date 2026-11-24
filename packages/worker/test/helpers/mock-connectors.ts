/**
 * Test Mock Connectors and Fixtures for MigrationGuard Worker Tests
 */

import {
  DestinationConnector,
  DestinationRecord,
  ReadBatchOptions,
  SourceBatch,
  SourceConnector,
  SourceCursor,
  SourceRecordEnvelope,
  TransformedBatch,
  WriteOptions,
  WriteResult,
} from '../../src/types.js';

export class MockSourceConnector implements SourceConnector {
  public records: SourceRecordEnvelope[] = [];
  public failAtCall?: number;
  public failError?: Error;
  private callCount = 0;

  constructor(records: SourceRecordEnvelope[] = []) {
    this.records = records;
  }

  public async testConnection(): Promise<{ success: boolean; latencyMs: number }> {
    return { success: true, latencyMs: 5 };
  }

  public async readBatch(
    cursor: SourceCursor | null,
    options: ReadBatchOptions,
  ): Promise<SourceBatch> {
    this.callCount++;
    if (this.failAtCall && this.callCount === this.failAtCall) {
      throw this.failError || new Error('Simulated read failure');
    }

    const batchSize = options.batchSize;
    let startIndex = 0;

    if (cursor?.lastId !== undefined && cursor.lastId !== null) {
      const idx = this.records.findIndex((r) => r.sourceKey === String(cursor.lastId));
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    } else if (cursor?.offset !== undefined) {
      startIndex = cursor.offset;
    }

    const pageRecords = this.records.slice(startIndex, startIndex + batchSize);
    const hasMore = startIndex + batchSize < this.records.length;
    const lastRecord = pageRecords[pageRecords.length - 1];

    const nextCursor: SourceCursor | null = hasMore && lastRecord
      ? { lastId: lastRecord.sourceKey, offset: startIndex + pageRecords.length }
      : null;

    return {
      records: pageRecords,
      nextCursor,
      hasMore,
      stats: {
        recordsCount: pageRecords.length,
        bytesRead: pageRecords.length * 150,
      },
    };
  }

  public async close(): Promise<void> {}
}

export class MockDestinationConnector implements DestinationConnector {
  public store = new Map<string, Record<string, unknown>>();
  public failAtCall?: number;
  public failError?: Error;
  public failOnKeys?: Set<string>;
  public writeCallCount = 0;
  public simulateNetworkHangupOnCommit = false;

  public async testConnection(): Promise<{ success: boolean; latencyMs: number }> {
    return { success: true, latencyMs: 5 };
  }

  public async writeBatch(
    batch: TransformedBatch,
    options: WriteOptions,
  ): Promise<WriteResult> {
    this.writeCallCount++;

    if (this.failAtCall && this.writeCallCount === this.failAtCall) {
      throw this.failError || new Error('Simulated destination write failure');
    }

    if (this.simulateNetworkHangupOnCommit) {
      // Simulate socket reset during commit
      const err = new Error('read ECONNRESET - connection dropped during commit');
      (err as Record<string, unknown>).code = 'ECONNRESET';
      throw err;
    }

    let recordsWritten = 0;
    let recordsSkipped = 0;
    let recordsFailed = 0;
    const writtenKeys: string[] = [];
    const skippedKeys: string[] = [];
    const failedKeys: Array<{ key: string; error: string; code?: string }> = [];

    for (const record of batch.records) {
      const key = record.destinationKey;

      if (this.failOnKeys && this.failOnKeys.has(key)) {
        recordsFailed++;
        failedKeys.push({ key, error: `Simulated write failure on key ${key}`, code: '23502' });
        continue;
      }

      const exists = this.store.has(key);

      if (options.writeMode === 'insert_only') {
        if (exists) {
          recordsFailed++;
          failedKeys.push({
            key,
            error: `Key ${key} already exists (insert-only violation)`,
            code: '23505',
          });
        } else {
          this.store.set(key, record.data);
          recordsWritten++;
          writtenKeys.push(key);
        }
      } else if (options.writeMode === 'upsert') {
        if (exists) {
          const current = this.store.get(key) || {};
          this.store.set(key, { ...current, ...record.data });
        } else {
          this.store.set(key, record.data);
        }
        recordsWritten++;
        writtenKeys.push(key);
      } else if (options.writeMode === 'skip_existing') {
        if (exists) {
          recordsSkipped++;
          skippedKeys.push(key);
        } else {
          this.store.set(key, record.data);
          recordsWritten++;
          writtenKeys.push(key);
        }
      }
    }

    return {
      recordsWritten,
      recordsSkipped,
      recordsFailed,
      writtenKeys,
      skippedKeys,
      failedKeys,
      durationMs: 10,
    };
  }

  public async readByKeys(
    destinationObject: string,
    keys: string[],
    keyColumn = 'id',
    projectColumns?: string[],
  ): Promise<DestinationRecord[]> {
    const results: DestinationRecord[] = [];
    for (const key of keys) {
      if (this.store.has(key)) {
        const row = this.store.get(key)!;
        let data = row;
        if (projectColumns && projectColumns.length > 0) {
          const projected: Record<string, unknown> = {};
          for (const col of projectColumns) {
            if (col in row) projected[col] = row[col];
          }
          if (keyColumn in row && !(keyColumn in projected)) {
            projected[keyColumn] = row[keyColumn];
          }
          data = projected;
        }
        results.push({
          destinationKey: String(row[keyColumn] !== undefined ? row[keyColumn] : key),
          data,
        });
      }
    }
    return results;
  }

  public async close(): Promise<void> {}
}
