import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/engine/migration-runner.js';
import { SourceRecordEnvelope } from '../src/types.js';
import { MockDestinationConnector, MockSourceConnector } from './helpers/mock-connectors.js';

describe('Pause, Resume, and Cancel Lifecycle Hooks (FR-EXEC-005, FR-EXEC-007)', () => {
  it('pauses and resumes an active migration run cleanly', async () => {
    // 60 records in batches of 10 -> 6 batches
    const records: SourceRecordEnvelope[] = Array.from({ length: 60 }, (_, i) => ({
      sourceObject: 'users',
      sourceKey: `user_${i}`,
      payload: { name: `User ${i}` },
      extractedAt: new Date().toISOString(),
    }));

    const sourceConnector = new MockSourceConnector(records);
    const destinationConnector = new MockDestinationConnector();
    const runner = new MigrationRunner({ sourceConnector, destinationConnector });

    const runId = 'run_lifecycle_test';

    // Start in background
    const startPromise = runner.start({
      migrationRunId: runId,
      sourceObject: 'users',
      destinationObject: 'users',
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      batchSize: 10,
    });

    // Pause immediately
    await runner.pause(runId);
    await startPromise;

    expect(runner.getStatus(runId)).toBe('PAUSED');
    const pausedProgress = await runner.getProgress(runId);
    expect(pausedProgress.status).toBe('PAUSED');

    // Resume
    await runner.resume(runId);

    expect(runner.getStatus(runId)).toBe('COMPLETED');
    expect(destinationConnector.store.size).toBe(60);

    const completedProgress = await runner.getProgress(runId);
    expect(completedProgress.status).toBe('COMPLETED');
    expect(completedProgress.recordsWritten).toBe(60);
    expect(completedProgress.batchesCommitted).toBe(6);
    expect(completedProgress.throughputRecordsPerSec).toBeGreaterThanOrEqual(0);
  });

  it('cancels an active migration run', async () => {
    const records: SourceRecordEnvelope[] = Array.from({ length: 100 }, (_, i) => ({
      sourceObject: 'events',
      sourceKey: `evt_${i}`,
      payload: { event: `Event ${i}` },
      extractedAt: new Date().toISOString(),
    }));

    const sourceConnector = new MockSourceConnector(records);
    const destinationConnector = new MockDestinationConnector();
    const runner = new MigrationRunner({ sourceConnector, destinationConnector });

    const runId = 'run_cancel_test';

    const startPromise = runner.start({
      migrationRunId: runId,
      sourceObject: 'events',
      destinationObject: 'events',
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      batchSize: 10,
    });

    await runner.cancel(runId);
    await startPromise;

    expect(runner.getStatus(runId)).toBe('CANCELLED');
    const progress = await runner.getProgress(runId);
    expect(progress.status).toBe('CANCELLED');
  });
});
