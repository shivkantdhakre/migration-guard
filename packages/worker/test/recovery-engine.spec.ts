import { describe, expect, it } from 'vitest';
import { BatchManifestTracker } from '../src/engine/batch-manifest.js';
import { CheckpointManager } from '../src/engine/checkpoint.js';
import { RecoveryEngine } from '../src/engine/recovery-engine.js';
import { MockDestinationConnector } from './helpers/mock-connectors.js';

describe('Recovery Engine & Crash Reconciliation Matrix', () => {
  it('reconciles crash after target commit when destination records and manifests are verified (DESTINATION_WRITTEN)', async () => {
    const destinationConnector = new MockDestinationConnector();
    // Simulate that the records landed in destination database
    destinationConnector.store.set('ord_25', { id: 'ord_25', amount: 100 });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    // Create a batch that crashed at DESTINATION_WRITTEN
    const batch = await manifestTracker.createBatch({
      migrationRunId: 'run_crash_1',
      batchKey: 'batch_dw',
      sequenceNo: 1,
      sourceObject: 'orders',
      destinationObject: 'orders',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_1', 'batch_dw', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_1', 'batch_dw', 'DESTINATION_WRITTEN');
    await manifestTracker.updateCounters('run_crash_1', 'batch_dw', {
      recordsRead: 1,
      recordsWritten: 1,
      sourceCursorEnd: { lastId: 'ord_25' },
    });

    // Record manifests for written records
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_1',
        batchKey: 'batch_dw',
        sourceObject: 'orders',
        sourceKey: 'src_ord_25',
        destinationObject: 'orders',
        destinationKey: 'ord_25',
        status: 'WRITTEN',
      },
    ]);

    // Reconcile
    const plan = await engine.prepareResume('run_crash_1', 'orders', 'orders');

    expect(plan.lastCommittedSequenceNo).toBe(1);
    expect(plan.startingCursor?.lastId).toBe('ord_25');
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');

    const updatedBatch = await manifestTracker.getBatch('run_crash_1', 'batch_dw');
    expect(updatedBatch?.status).toBe('COMMITTED');
  });

  it('resets DESTINATION_WRITTEN to RETRY_WAIT when durable manifests are missing', async () => {
    const destinationConnector = new MockDestinationConnector();
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_dw_nomanifest',
      batchKey: 'batch_dw_nm',
      sequenceNo: 1,
      sourceObject: 'orders',
      destinationObject: 'orders',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_dw_nomanifest', 'batch_dw_nm', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_dw_nomanifest', 'batch_dw_nm', 'DESTINATION_WRITTEN');
    await manifestTracker.updateCounters('run_crash_dw_nomanifest', 'batch_dw_nm', {
      recordsRead: 25,
      recordsWritten: 25,
      sourceCursorEnd: { lastId: 'ord_25' },
    });

    // No manifests recorded!
    const plan = await engine.prepareResume('run_crash_dw_nomanifest', 'orders', 'orders');

    expect(plan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(plan.lastCommittedSequenceNo).toBe(0);

    const updatedBatch = await manifestTracker.getBatch('run_crash_dw_nomanifest', 'batch_dw_nm');
    expect(updatedBatch?.status).toBe('RETRY_WAIT');
  });

  it('reconciles crash after manifest persisted with verified destination records (MANIFEST_COMMITTED)', async () => {
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.store.set('cust_15', { id: 'cust_15', name: 'Customer 15' });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_2',
      batchKey: 'batch_mc',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_2', 'batch_mc', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_2', 'batch_mc', 'MANIFEST_COMMITTED');
    await manifestTracker.updateCounters('run_crash_2', 'batch_mc', {
      recordsRead: 1,
      recordsWritten: 1,
      sourceCursorEnd: { lastId: 'cust_15' },
    });

    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_2',
        batchKey: 'batch_mc',
        sourceObject: 'customers',
        sourceKey: 'src_cust_15',
        destinationObject: 'customers',
        destinationKey: 'cust_15',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_2', 'customers', 'customers');

    expect(plan.lastCommittedSequenceNo).toBe(1);
    expect(plan.startingCursor?.lastId).toBe('cust_15');
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');

    const checkpoint = await checkpointManager.getCheckpoint('run_crash_2', 'customers');
    expect(checkpoint?.lastCommittedSequenceNo).toBe(1);
  });

  it('resets MANIFEST_COMMITTED to RETRY_WAIT when destination records are missing', async () => {
    const destinationConnector = new MockDestinationConnector();
    // Destination store is empty: records did not land
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_mc_missing',
      batchKey: 'batch_mc_miss',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_mc_missing', 'batch_mc_miss', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_mc_missing', 'batch_mc_miss', 'MANIFEST_COMMITTED');
    await manifestTracker.updateCounters('run_crash_mc_missing', 'batch_mc_miss', {
      recordsRead: 1,
      recordsWritten: 1,
      sourceCursorEnd: { lastId: 'cust_15' },
    });

    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_mc_missing',
        batchKey: 'batch_mc_miss',
        sourceObject: 'customers',
        sourceKey: 'src_cust_15',
        destinationObject: 'customers',
        destinationKey: 'cust_15',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_mc_missing', 'customers', 'customers');

    expect(plan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(plan.lastCommittedSequenceNo).toBe(0);

    const updated = await manifestTracker.getBatch('run_crash_mc_missing', 'batch_mc_miss');
    expect(updated?.status).toBe('RETRY_WAIT');
  });

  it('resets MANIFEST_COMMITTED to RETRY_WAIT when RFC 8785 canonical hash mismatches', async () => {
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.store.set('cust_15', { id: 'cust_15', name: 'Corrupted Name' });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_mc_hash_mismatch',
      batchKey: 'batch_mc_hm',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_mc_hash_mismatch', 'batch_mc_hm', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_mc_hash_mismatch', 'batch_mc_hm', 'MANIFEST_COMMITTED');
    await manifestTracker.updateCounters('run_crash_mc_hash_mismatch', 'batch_mc_hm', {
      recordsRead: 1,
      recordsWritten: 1,
      sourceCursorEnd: { lastId: 'cust_15' },
    });

    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_mc_hash_mismatch',
        batchKey: 'batch_mc_hm',
        sourceObject: 'customers',
        sourceKey: 'src_cust_15',
        destinationObject: 'customers',
        destinationKey: 'cust_15',
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_mc_hash_mismatch', 'customers', 'customers');

    expect(plan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(plan.lastCommittedSequenceNo).toBe(0);

    const updated = await manifestTracker.getBatch('run_crash_mc_hash_mismatch', 'batch_mc_hm');
    expect(updated?.status).toBe('RETRY_WAIT');
  });

  it('reconciles OUTCOME_UNKNOWN when destination write actually succeeded before disconnect', async () => {
    const destinationConnector = new MockDestinationConnector();
    // Simulate that the records actually landed in destination database!
    destinationConnector.store.set('dest_key_1', { id: 'dest_key_1', val: 1 });
    destinationConnector.store.set('dest_key_2', { id: 'dest_key_2', val: 2 });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_unknown_success',
      batchKey: 'batch_unknown_1',
      sequenceNo: 1,
      sourceObject: 'items',
      destinationObject: 'items',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_unknown_success', 'batch_unknown_1', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_unknown_success', 'batch_unknown_1', 'WRITE_STARTED');
    await manifestTracker.transitionState('run_crash_unknown_success', 'batch_unknown_1', 'OUTCOME_UNKNOWN');

    // Record manifests for destination keys
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_unknown_success',
        batchKey: 'batch_unknown_1',
        sourceObject: 'items',
        sourceKey: 'src_1',
        destinationObject: 'items',
        destinationKey: 'dest_key_1',
        status: 'WRITTEN',
      },
      {
        migrationRunId: 'run_crash_unknown_success',
        batchKey: 'batch_unknown_1',
        sourceObject: 'items',
        sourceKey: 'src_2',
        destinationObject: 'items',
        destinationKey: 'dest_key_2',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_unknown_success', 'items', 'items');

    // Engine discovered all records exist in destination, so it commits the batch!
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');
    expect(plan.lastCommittedSequenceNo).toBe(1);

    const updated = await manifestTracker.getBatch('run_crash_unknown_success', 'batch_unknown_1');
    expect(updated?.status).toBe('COMMITTED');
  });

  it('reconciles OUTCOME_UNKNOWN when destination write did not land, resetting to RETRY_WAIT', async () => {
    const destinationConnector = new MockDestinationConnector();
    // Destination store is empty: write did not land before socket drop
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_unknown_fail',
      batchKey: 'batch_unknown_2',
      sequenceNo: 1,
      sourceObject: 'items',
      destinationObject: 'items',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_unknown_fail', 'batch_unknown_2', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_unknown_fail', 'batch_unknown_2', 'WRITE_STARTED');
    await manifestTracker.transitionState('run_crash_unknown_fail', 'batch_unknown_2', 'OUTCOME_UNKNOWN');

    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_unknown_fail',
        batchKey: 'batch_unknown_2',
        sourceObject: 'items',
        sourceKey: 'src_1',
        destinationObject: 'items',
        destinationKey: 'missing_key_1',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_unknown_fail', 'items', 'items');

    // Engine discovered records are missing in destination, resets to RETRY_WAIT for idempotent retry
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(plan.lastCommittedSequenceNo).toBe(0);

    const updated = await manifestTracker.getBatch('run_crash_unknown_fail', 'batch_unknown_2');
    expect(updated?.status).toBe('RETRY_WAIT');
  });

  it('reconciles OUTCOME_UNKNOWN using custom non-id destination key (e.g. reading_id or device_id)', async () => {
    const destinationConnector = new MockDestinationConnector();
    // Simulate table with custom primary key column 'reading_id'
    destinationConnector.store.set('read_1001', { reading_id: 'read_1001', metric: 42.5 });
    destinationConnector.store.set('read_1002', { reading_id: 'read_1002', metric: 98.1 });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_custom_key',
      batchKey: 'batch_telemetry_01',
      sequenceNo: 1,
      sourceObject: 'sensor_readings',
      destinationObject: 'telemetry_readings',
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState('run_crash_custom_key', 'batch_telemetry_01', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_custom_key', 'batch_telemetry_01', 'WRITE_STARTED');
    await manifestTracker.transitionState('run_crash_custom_key', 'batch_telemetry_01', 'OUTCOME_UNKNOWN');

    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_custom_key',
        batchKey: 'batch_telemetry_01',
        sourceObject: 'sensor_readings',
        sourceKey: 's_1',
        destinationObject: 'telemetry_readings',
        destinationKey: 'read_1001',
        status: 'WRITTEN',
      },
      {
        migrationRunId: 'run_crash_custom_key',
        batchKey: 'batch_telemetry_01',
        sourceObject: 'sensor_readings',
        sourceKey: 's_2',
        destinationObject: 'telemetry_readings',
        destinationKey: 'read_1002',
        status: 'WRITTEN',
      },
    ]);

    // Pass custom destinationKey 'reading_id' instead of default 'id'
    const plan = await engine.prepareResume(
      'run_crash_custom_key',
      'sensor_readings',
      'telemetry_readings',
      'reading_id',
    );

    expect(plan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');
    expect(plan.lastCommittedSequenceNo).toBe(1);

    const updated = await manifestTracker.getBatch('run_crash_custom_key', 'batch_telemetry_01');
    expect(updated?.status).toBe('COMMITTED');
  });

  it('reconciles OUTCOME_UNKNOWN by verifying destination canonical hash matches manifest contentHash', async () => {
    const { calculateCanonicalHash } = await import('@migrationguard/core');
    const destinationConnector = new MockDestinationConnector();
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const recordData = { id: 'rec_hash_1', name: 'Alice', score: 100 };
    destinationConnector.store.set('rec_hash_1', recordData);

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_hash_verify',
      batchKey: 'batch_hash_1',
      sequenceNo: 1,
      sourceObject: 'users',
      destinationObject: 'users',
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState('run_hash_verify', 'batch_hash_1', 'RUNNING');
    await manifestTracker.updateSubStage('run_hash_verify', 'batch_hash_1', 'WRITE_STARTED');
    await manifestTracker.transitionState('run_hash_verify', 'batch_hash_1', 'OUTCOME_UNKNOWN');

    // Matching hash
    const contentHash = calculateCanonicalHash(recordData);
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_hash_verify',
        batchKey: 'batch_hash_1',
        sourceObject: 'users',
        sourceKey: 'src_u1',
        destinationObject: 'users',
        destinationKey: 'rec_hash_1',
        contentHash,
        status: 'WRITTEN',
      },
    ]);

    const successPlan = await engine.prepareResume('run_hash_verify', 'users', 'users');
    expect(successPlan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');

    // Corrupted / mismatching hash resets to RETRY_WAIT
    await manifestTracker.createBatch({
      migrationRunId: 'run_hash_corrupt',
      batchKey: 'batch_hash_2',
      sequenceNo: 1,
      sourceObject: 'users',
      destinationObject: 'users',
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState('run_hash_corrupt', 'batch_hash_2', 'RUNNING');
    await manifestTracker.updateSubStage('run_hash_corrupt', 'batch_hash_2', 'WRITE_STARTED');
    await manifestTracker.transitionState('run_hash_corrupt', 'batch_hash_2', 'OUTCOME_UNKNOWN');
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_hash_corrupt',
        batchKey: 'batch_hash_2',
        sourceObject: 'users',
        sourceKey: 'src_u2',
        destinationObject: 'users',
        destinationKey: 'rec_hash_1',
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', // Intentional mismatch
        status: 'WRITTEN',
      },
    ]);

    const failPlan = await engine.prepareResume('run_hash_corrupt', 'users', 'users');
    expect(failPlan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(failPlan.reconciledBatches[0].actionTaken).toContain('Content hash mismatch');
  });

  it('reconciles crash during WRITE_STARTED: resets to RETRY_WAIT if records did not land', async () => {
    const destinationConnector = new MockDestinationConnector();
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_write_started',
      batchKey: 'batch_ws_1',
      sequenceNo: 1,
      sourceObject: 'orders',
      destinationObject: 'orders',
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState('run_crash_write_started', 'batch_ws_1', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_write_started', 'batch_ws_1', 'WRITE_STARTED');
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_write_started',
        batchKey: 'batch_ws_1',
        sourceObject: 'orders',
        sourceKey: 'src_ws_1',
        destinationObject: 'orders',
        destinationKey: 'dest_ws_1',
        status: 'WRITTEN',
      },
    ]);

    // Destination store is empty: process crashed right as write started before persistence
    const plan = await engine.prepareResume('run_crash_write_started', 'orders', 'orders');
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('RETRY_WAIT');
    expect(plan.lastCommittedSequenceNo).toBe(0);

    const updated = await manifestTracker.getBatch('run_crash_write_started', 'batch_ws_1');
    expect(updated?.status).toBe('RETRY_WAIT');
  });

  it('reconciles crash during WRITE_STARTED: commits if destination write completed before crash', async () => {
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.store.set('dest_ws_2', { id: 'dest_ws_2', amount: 500 });
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const engine = new RecoveryEngine({
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    await manifestTracker.createBatch({
      migrationRunId: 'run_crash_write_started_ok',
      batchKey: 'batch_ws_2',
      sequenceNo: 1,
      sourceObject: 'orders',
      destinationObject: 'orders',
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState('run_crash_write_started_ok', 'batch_ws_2', 'RUNNING');
    await manifestTracker.updateSubStage('run_crash_write_started_ok', 'batch_ws_2', 'WRITE_STARTED');
    await manifestTracker.recordManifests([
      {
        migrationRunId: 'run_crash_write_started_ok',
        batchKey: 'batch_ws_2',
        sourceObject: 'orders',
        sourceKey: 'src_ws_2',
        destinationObject: 'orders',
        destinationKey: 'dest_ws_2',
        status: 'WRITTEN',
      },
    ]);

    const plan = await engine.prepareResume('run_crash_write_started_ok', 'orders', 'orders');
    expect(plan.reconciledBatches[0].resolvedStatus).toBe('COMMITTED');
    expect(plan.lastCommittedSequenceNo).toBe(1);

    const updated = await manifestTracker.getBatch('run_crash_write_started_ok', 'batch_ws_2');
    expect(updated?.status).toBe('COMMITTED');
  });
});
