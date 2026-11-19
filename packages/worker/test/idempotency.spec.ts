import { describe, expect, it } from 'vitest';
import { DestinationWriter } from '../src/engine/destination-writer.js';
import { TransformedBatch } from '../src/types.js';
import { MockDestinationConnector } from './helpers/mock-connectors.js';

describe('Destination Writer & Idempotency (FR-EXEC-006)', () => {
  it('insert-only mode fails when destination keys already exist', async () => {
    const connector = new MockDestinationConnector();
    // Pre-populate key 'cust_1'
    connector.store.set('cust_1', { id: 'cust_1', name: 'Existing Alice' });

    const writer = new DestinationWriter({ connector });

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_test_01',
      records: [
        {
          destinationKey: 'cust_1',
          sourceKey: 'cust_1',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_1', name: 'New Alice' },
        },
      ],
    };

    const result = await writer.write(batch, {
      migrationRunId: 'run_1',
      sourceObject: 'customers',
      writeMode: 'insert_only',
    });

    expect(result.recordsWritten).toBe(0);
    expect(result.recordsFailed).toBe(1);
    expect(result.failedKeys[0].code).toBe('23505');
  });

  it('upsert mode updates existing keys without duplicating rows', async () => {
    const connector = new MockDestinationConnector();
    connector.store.set('cust_1', { id: 'cust_1', name: 'Original Name', tier: 'standard' });

    const writer = new DestinationWriter({ connector });

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_upsert_01',
      records: [
        {
          destinationKey: 'cust_1',
          sourceKey: 'cust_1',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_1', name: 'Updated Name', tier: 'premium' },
        },
        {
          destinationKey: 'cust_2',
          sourceKey: 'cust_2',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_2', name: 'New Customer', tier: 'standard' },
        },
      ],
    };

    const result = await writer.write(batch, {
      migrationRunId: 'run_1',
      sourceObject: 'customers',
      writeMode: 'upsert',
    });

    expect(result.recordsWritten).toBe(2);
    expect(connector.store.size).toBe(2);
    expect(connector.store.get('cust_1')?.name).toBe('Updated Name');
    expect(connector.store.get('cust_1')?.tier).toBe('premium');
    expect(connector.store.get('cust_2')?.name).toBe('New Customer');
  });

  it('skip-existing mode skips already existing keys and tracks skippedKeys', async () => {
    const connector = new MockDestinationConnector();
    connector.store.set('cust_1', { id: 'cust_1', name: 'Original Name' });

    const writer = new DestinationWriter({ connector });

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_skip_01',
      records: [
        {
          destinationKey: 'cust_1',
          sourceKey: 'cust_1',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_1', name: 'Should Be Skipped' },
        },
        {
          destinationKey: 'cust_2',
          sourceKey: 'cust_2',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_2', name: 'New Customer' },
        },
      ],
    };

    const result = await writer.write(batch, {
      migrationRunId: 'run_1',
      sourceObject: 'customers',
      writeMode: 'skip_existing',
    });

    expect(result.recordsWritten).toBe(1);
    expect(result.recordsSkipped).toBe(1);
    expect(result.skippedKeys).toEqual(['cust_1']);
    // Name should not be updated
    expect(connector.store.get('cust_1')?.name).toBe('Original Name');
  });

  it('idempotently handles re-execution of the same batch in upsert mode', async () => {
    const connector = new MockDestinationConnector();
    const writer = new DestinationWriter({ connector });

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_idempotent_01',
      records: [
        {
          destinationKey: 'cust_10',
          sourceKey: 'cust_10',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_10', name: 'Customer 10' },
        },
        {
          destinationKey: 'cust_11',
          sourceKey: 'cust_11',
          sourceObject: 'customers',
          destinationObject: 'customers',
          data: { id: 'cust_11', name: 'Customer 11' },
        },
      ],
    };

    // First write execution
    const firstResult = await writer.write(batch, {
      migrationRunId: 'run_idemp',
      sourceObject: 'customers',
      writeMode: 'upsert',
    });
    expect(firstResult.recordsWritten).toBe(2);
    expect(connector.store.size).toBe(2);

    // Replay write execution (simulating network retry or redelivery)
    const secondResult = await writer.write(batch, {
      migrationRunId: 'run_idemp',
      sourceObject: 'customers',
      writeMode: 'upsert',
    });
    expect(secondResult.recordsWritten).toBe(2);
    // Total count in database MUST remain exactly 2, no duplicates created!
    expect(connector.store.size).toBe(2);
  });

  it('deduplicates intra-batch records by destinationKey before dispatching', async () => {
    const connector = new MockDestinationConnector();
    const writer = new DestinationWriter({ connector });

    const batch: TransformedBatch = {
      destinationObject: 'orders',
      batchKey: 'batch_dedup_01',
      records: [
        {
          destinationKey: 'ord_1',
          sourceKey: 'ord_1_v1',
          sourceObject: 'orders',
          destinationObject: 'orders',
          data: { id: 'ord_1', status: 'pending' },
        },
        {
          destinationKey: 'ord_1', // Duplicate key in same batch
          sourceKey: 'ord_1_v2',
          sourceObject: 'orders',
          destinationObject: 'orders',
          data: { id: 'ord_1', status: 'completed' },
        },
      ],
    };

    const result = await writer.write(batch, {
      migrationRunId: 'run_dedup',
      sourceObject: 'orders',
      writeMode: 'insert_only',
    });

    expect(result.recordsWritten).toBe(1);
    expect(connector.store.size).toBe(1);
    expect(connector.store.get('ord_1')?.status).toBe('completed');
  });
});
