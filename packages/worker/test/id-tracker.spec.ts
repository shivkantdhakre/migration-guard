import { describe, expect, it } from 'vitest';
import { IdTracker } from '../src/engine/id-tracker.js';

describe('Source-to-Destination ID Tracker (FR-MAP-005)', () => {
  it('records and retrieves individual source-to-destination mappings', async () => {
    const tracker = new IdTracker();

    await tracker.recordMapping('run_1', 'mongo_customers', 'mongo_id_101', 'pg_customers', 'pg_id_501');

    const destKey = await tracker.getDestinationKey('run_1', 'mongo_customers', 'mongo_id_101');
    expect(destKey).toBe('pg_id_501');

    const srcKey = await tracker.getSourceKey('run_1', 'pg_customers', 'pg_id_501');
    expect(srcKey).toBe('mongo_id_101');

    const exists = await tracker.hasMapping('run_1', 'mongo_customers', 'mongo_id_101');
    expect(exists).toBe(true);

    const nonExistent = await tracker.getDestinationKey('run_1', 'mongo_customers', 'non_existent');
    expect(nonExistent).toBeNull();
  });

  it('records batch mappings and isolates by migrationRunId', async () => {
    const tracker = new IdTracker();

    const batch = [
      {
        migrationRunId: 'run_A',
        sourceObject: 'users',
        sourceKey: 'u1',
        destinationObject: 'users',
        destinationKey: 'dest_u1',
      },
      {
        migrationRunId: 'run_A',
        sourceObject: 'users',
        sourceKey: 'u2',
        destinationObject: 'users',
        destinationKey: 'dest_u2',
      },
      {
        migrationRunId: 'run_B',
        sourceObject: 'users',
        sourceKey: 'u1', // same sourceKey in different run
        destinationObject: 'users',
        destinationKey: 'dest_u1_runB',
      },
    ];

    await tracker.recordBatchMappings(batch);

    // Run A
    expect(await tracker.getDestinationKey('run_A', 'users', 'u1')).toBe('dest_u1');
    expect(await tracker.getDestinationKey('run_A', 'users', 'u2')).toBe('dest_u2');

    // Run B isolation
    expect(await tracker.getDestinationKey('run_B', 'users', 'u1')).toBe('dest_u1_runB');

    // List by run
    const runAMappings = await tracker.getMappingsByRun('run_A');
    expect(runAMappings.length).toBe(2);

    const runBMappings = await tracker.getMappingsByRun('run_B');
    expect(runBMappings.length).toBe(1);
  });

  it('deletes mappings scoped to a specific migration run', async () => {
    const tracker = new IdTracker();
    await tracker.recordMapping('run_to_delete', 'orders', 'ord_1', 'orders', 'pg_ord_1');
    await tracker.recordMapping('run_to_keep', 'orders', 'ord_2', 'orders', 'pg_ord_2');

    await tracker.deleteByRun('run_to_delete');

    expect(await tracker.getDestinationKey('run_to_delete', 'orders', 'ord_1')).toBeNull();
    expect(await tracker.getDestinationKey('run_to_keep', 'orders', 'ord_2')).toBe('pg_ord_2');
  });
});
