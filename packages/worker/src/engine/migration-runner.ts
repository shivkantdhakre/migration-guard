/**
 * Migration Runner with Pause, Resume, and Cancel Lifecycle Hooks
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md (Section 7), 08_MIGRATION_ENGINE_DESIGN.md (Section 5), FR-EXEC-005, FR-EXEC-007
 *
 * Coordinates execution of batches with:
 * - pause: completes active in-flight batch, checkpoints safely, halts further dispatch
 * - resume: reconciles state, inspects checkpoint, resumes from last committed cursor
 * - cancel: safely stops in-flight work and cancels pending batches
 * - real-time progress calculation and throughput metrics
 */

import {
  DestinationConnector,
  MigrationJobPayload,
  MigrationRunProgress,
  MigrationRunStatus,
  SourceConnector,
  SourceCursor,
  TransformFunction,
  WriteMode,
} from '../types.js';
import { BatchManifestTracker } from './batch-manifest.js';
import { CheckpointManager } from './checkpoint.js';
import { IdTracker } from './id-tracker.js';
import { QueueHandler } from './queue-handler.js';
import { RecoveryEngine } from './recovery-engine.js';

export interface StartMigrationConfig {
  migrationRunId: string;
  sourceObject: string;
  destinationObject: string;
  planVersionId: string;
  mappingVersionId: string;
  writeMode?: WriteMode;
  batchSize?: number;
  initialCursor?: SourceCursor | null;
  transformFn?: TransformFunction;
  conflictColumns?: string[];
  updateColumns?: string[];
}

export class MigrationRunner {
  private sourceConnector: SourceConnector;
  private destinationConnector: DestinationConnector;
  private manifestTracker: BatchManifestTracker;
  private checkpointManager: CheckpointManager;
  private idTracker: IdTracker;
  private recoveryEngine: RecoveryEngine;

  // Run states by runId
  private runStatuses = new Map<string, MigrationRunStatus>();
  private abortControllers = new Map<string, AbortController>();
  private activeConfigs = new Map<string, StartMigrationConfig>();
  private runStartTimes = new Map<string, number>();

  constructor(deps: {
    sourceConnector: SourceConnector;
    destinationConnector: DestinationConnector;
    manifestTracker?: BatchManifestTracker;
    checkpointManager?: CheckpointManager;
    idTracker?: IdTracker;
  }) {
    this.sourceConnector = deps.sourceConnector;
    this.destinationConnector = deps.destinationConnector;
    this.manifestTracker = deps.manifestTracker ?? new BatchManifestTracker();
    this.checkpointManager = deps.checkpointManager ?? new CheckpointManager();
    this.idTracker = deps.idTracker ?? new IdTracker();

    this.recoveryEngine = new RecoveryEngine({
      destinationConnector: this.destinationConnector,
      manifestTracker: this.manifestTracker,
      checkpointManager: this.checkpointManager,
      idTracker: this.idTracker,
    });
  }

  public getStatus(migrationRunId: string): MigrationRunStatus {
    return this.runStatuses.get(migrationRunId) || 'PENDING';
  }

  /**
   * Start a migration run
   */
  public async start(config: StartMigrationConfig): Promise<void> {
    const runId = config.migrationRunId;
    this.runStatuses.set(runId, 'RUNNING');
    this.activeConfigs.set(runId, config);
    this.runStartTimes.set(runId, Date.now());

    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);

    // Initial sequence & cursor
    let sequenceNo = 1;
    let cursor: SourceCursor | null = config.initialCursor ?? null;

    // Check existing checkpoint (if any)
    const existingCheckpoint = await this.checkpointManager.getCheckpoint(runId, config.sourceObject);
    if (existingCheckpoint) {
      sequenceNo = existingCheckpoint.lastCommittedSequenceNo + 1;
      cursor = existingCheckpoint.lastCommittedCursor;
    }

    await this.runLoop(config, sequenceNo, cursor, abortController.signal);
  }

  /**
   * Pause an active migration run
   */
  public async pause(migrationRunId: string): Promise<void> {
    const currentStatus = this.getStatus(migrationRunId);
    if (currentStatus !== 'RUNNING') {
      return;
    }

    this.runStatuses.set(migrationRunId, 'PAUSED');
    const controller = this.abortControllers.get(migrationRunId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Resume a paused or interrupted migration run
   */
  public async resume(migrationRunId: string): Promise<void> {
    const currentStatus = this.getStatus(migrationRunId);
    if (currentStatus !== 'PAUSED' && currentStatus !== 'FAILED') {
      throw new Error(`Cannot resume migration run in status: ${currentStatus}`);
    }

    const config = this.activeConfigs.get(migrationRunId);
    if (!config) {
      throw new Error(`No active configuration found for migration run: ${migrationRunId}`);
    }

    // Reconcile crash states & prepare resume
    const resumePlan = await this.recoveryEngine.prepareResume(
      migrationRunId,
      config.sourceObject,
      config.destinationObject,
    );

    this.runStatuses.set(migrationRunId, 'RUNNING');
    const abortController = new AbortController();
    this.abortControllers.set(migrationRunId, abortController);

    const nextSequenceNo = resumePlan.lastCommittedSequenceNo + 1;
    await this.runLoop(config, nextSequenceNo, resumePlan.startingCursor, abortController.signal);
  }

  /**
   * Cancel an active migration run
   */
  public async cancel(migrationRunId: string): Promise<void> {
    this.runStatuses.set(migrationRunId, 'CANCELLED');
    const controller = this.abortControllers.get(migrationRunId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Get real-time progress report
   */
  public async getProgress(migrationRunId: string): Promise<MigrationRunProgress> {
    const status = this.getStatus(migrationRunId);
    const batches = await this.manifestTracker.listBatches(migrationRunId);

    let recordsRead = 0;
    let recordsWritten = 0;
    let recordsSkipped = 0;
    let recordsFailed = 0;
    let batchesCommitted = 0;
    let batchesFailed = 0;
    let lastCommittedSequenceNo = 0;
    let activeBatchKey: string | undefined;

    for (const b of batches) {
      recordsRead += b.recordsRead;
      recordsWritten += b.recordsWritten;
      recordsSkipped += b.recordsSkipped;
      recordsFailed += b.recordsFailed;

      if (b.status === 'COMMITTED') {
        batchesCommitted++;
        if (b.sequenceNo > lastCommittedSequenceNo) {
          lastCommittedSequenceNo = b.sequenceNo;
        }
      } else if (b.status === 'FAILED_PERMANENT' || b.status === 'FAILED_RETRYABLE') {
        batchesFailed++;
      } else if (b.status === 'RUNNING') {
        activeBatchKey = b.batchKey;
      }
    }

    const startTime = this.runStartTimes.get(migrationRunId) || Date.now();
    const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
    const throughputRecordsPerSec = Math.round((recordsWritten / elapsedSeconds) * 10) / 10;

    return {
      migrationRunId,
      status,
      batchesTotal: batches.length,
      batchesCommitted,
      batchesFailed,
      recordsRead,
      recordsWritten,
      recordsSkipped,
      recordsFailed,
      throughputRecordsPerSec,
      activeBatchKey,
      lastCommittedSequenceNo,
      startedAt: new Date(startTime).toISOString(),
    };
  }

  /**
   * Main dispatch loop
   */
  private async runLoop(
    config: StartMigrationConfig,
    startSequence: number,
    startCursor: SourceCursor | null,
    signal: AbortSignal,
  ): Promise<void> {
    const queueHandler = new QueueHandler({
      sourceConnector: this.sourceConnector,
      destinationConnector: this.destinationConnector,
      manifestTracker: this.manifestTracker,
      checkpointManager: this.checkpointManager,
      idTracker: this.idTracker,
      transformFn: config.transformFn,
    });

    let currentSequence = startSequence;
    let currentCursor = startCursor;

    while (true) {
      if (signal.aborted) {
        break;
      }

      const batchKey = `batch_${config.sourceObject}_seq_${String(currentSequence).padStart(6, '0')}`;
      const payload: MigrationJobPayload = {
        jobId: `job_${config.migrationRunId}_${batchKey}`,
        migrationRunId: config.migrationRunId,
        batchKey,
        sequenceNo: currentSequence,
        sourceObject: config.sourceObject,
        destinationObject: config.destinationObject,
        cursorStart: currentCursor,
        batchSize: config.batchSize ?? 500,
        planVersionId: config.planVersionId,
        mappingVersionId: config.mappingVersionId,
        writeMode: config.writeMode ?? 'insert_only',
        conflictColumns: config.conflictColumns,
        updateColumns: config.updateColumns,
      };

      const result = await queueHandler.processJob(payload);

      if (result.status === 'FAILED_PERMANENT' || result.status === 'OUTCOME_UNKNOWN') {
        this.runStatuses.set(config.migrationRunId, 'FAILED');
        break;
      }

      if (result.status === 'FAILED_RETRYABLE') {
        // Paused/halted due to exhausted retries
        this.runStatuses.set(config.migrationRunId, 'FAILED');
        break;
      }

      if (!result.hasMore || result.recordsRead === 0) {
        // Completed all batches!
        this.runStatuses.set(config.migrationRunId, 'COMPLETED');
        break;
      }

      if (result.nextPayload) {
        currentSequence = result.nextPayload.sequenceNo;
        currentCursor = result.nextPayload.cursorStart;
      } else {
        break;
      }
    }
  }
}
