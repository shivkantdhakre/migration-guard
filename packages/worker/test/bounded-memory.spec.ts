import { describe, expect, it } from 'vitest';
import { BatchReader } from '../src/engine/batch-reader.js';
import { SourceRecordEnvelope } from '../src/types.js';
import { MockSourceConnector } from './helpers/mock-connectors.js';

describe('Bounded-Memory Streaming Batch Reader (FR-EXEC-002)', () => {
  it('streams large dataset in bounded chunks without loading entire db into memory', async () => {
    // Generate 500 synthetic source envelopes
    const mockRecords: SourceRecordEnvelope[] = Array.from({ length: 500 }, (_, i) => ({
      sourceObject: 'customers',
      sourceKey: `cust_${String(i).padStart(4, '0')}`,
      payload: { name: `Customer ${i}`, email: `cust${i}@example.com` },
      extractedAt: new Date().toISOString(),
    }));

    const connector = new MockSourceConnector(mockRecords);
    const reader = new BatchReader(connector);

    const batchSize = 100;
    const batches = [];
    let totalRecordsRead = 0;

    for await (const batch of reader.streamBatches(null, {
      sourceObject: 'customers',
      batchSize,
    })) {
      // Each yielded batch is strictly bounded to batchSize
      expect(batch.records.length).toBeLessThanOrEqual(batchSize);
      expect(batch.recordsCount).toBe(batch.records.length);
      expect(batch.bytesRead).toBeGreaterThan(0);
      batches.push(batch);
      totalRecordsRead += batch.records.length;
    }

    expect(totalRecordsRead).toBe(500);
    expect(batches.length).toBe(5);

    // Verify cursor progression
    expect(batches[0].sequenceNo).toBe(1);
    expect(batches[0].cursorStart).toBeNull();
    expect(batches[0].cursorEnd?.lastId).toBe('cust_0099');

    expect(batches[1].sequenceNo).toBe(2);
    expect(batches[1].cursorStart?.lastId).toBe('cust_0099');
    expect(batches[1].cursorEnd?.lastId).toBe('cust_0199');

    expect(batches[4].sequenceNo).toBe(5);
    expect(batches[4].hasMore).toBe(false);
  });

  it('respects abort signal and halts streaming early', async () => {
    const mockRecords: SourceRecordEnvelope[] = Array.from({ length: 100 }, (_, i) => ({
      sourceObject: 'orders',
      sourceKey: `ord_${i}`,
      payload: { amount: i * 10 },
      extractedAt: new Date().toISOString(),
    }));

    const connector = new MockSourceConnector(mockRecords);
    const reader = new BatchReader(connector);

    const controller = new AbortController();
    const yieldedBatches = [];

    for await (const batch of reader.streamBatches(null, {
      sourceObject: 'orders',
      batchSize: 20,
      abortSignal: controller.signal,
    })) {
      yieldedBatches.push(batch);
      // Abort after 2 batches
      if (yieldedBatches.length === 2) {
        controller.abort();
      }
    }

    expect(yieldedBatches.length).toBe(2);
  });

  it('handles empty source collection gracefully', async () => {
    const connector = new MockSourceConnector([]);
    const reader = new BatchReader(connector);

    const batches = [];
    for await (const batch of reader.streamBatches(null, { sourceObject: 'empty_col' })) {
      batches.push(batch);
    }

    expect(batches.length).toBe(1);
    expect(batches[0].records.length).toBe(0);
    expect(batches[0].hasMore).toBe(false);
  });

  it('classifies error when source connector fails during read', async () => {
    const connector = new MockSourceConnector([]);
    connector.failAtCall = 1;
    connector.failError = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });

    const reader = new BatchReader(connector);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of reader.streamBatches(null, { sourceObject: 'fail_col' })) {
        // should fail on first read
      }
    }).rejects.toThrow('Error reading batch 1');
  });
});
