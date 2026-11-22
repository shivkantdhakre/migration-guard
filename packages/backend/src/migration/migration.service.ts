import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { QueueService, MigrationJobPayload } from '../queue/queue.service';

@Injectable()
export class MigrationService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    @Optional() private queueService?: QueueService,
  ) {}

  async startMigrationRun(planVersionId: string, userId: string) {
    // 1. Fetch plan version with plan details
    const versionRes = await this.db.query(
      `SELECT mpv.*, mp.workspace_id, mp.project_id
       FROM migration_plan_versions mpv
       JOIN migration_plans mp ON mpv.plan_id = mp.id
       WHERE mpv.id = $1`,
      [planVersionId],
    );

    if (versionRes.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }

    const version = versionRes.rows[0];
    const workspaceId = version.workspace_id;
    const projectId = version.project_id;

    // Verify workspace access
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Engineer');

    // 2. Critical Safety Rule: Only approved plan versions can run.
    // Ensure the latest approval/rejection decision is explicitly 'APPROVE'.
    const approvalRes = await this.db.query(
      `SELECT * FROM approvals
       WHERE resource_type = 'PLAN_VERSION'
         AND resource_id = $1
         AND resource_hash = $2
       ORDER BY approved_at DESC LIMIT 1`,
      [planVersionId, version.plan_hash],
    );

    if (approvalRes.rows.length === 0 || approvalRes.rows[0].approval_status !== 'APPROVE') {
      throw new ForbiddenException({
        code: 'PLAN_NOT_APPROVED',
        message: 'Cannot execute migration: plan version has not received explicit approval or latest decision was rejected.',
        planVersionId,
        planHash: version.plan_hash,
      });
    }

    // 3. Create migration_runs row in QUEUED state
    const runRes = await this.db.query(
      `INSERT INTO migration_runs (workspace_id, project_id, plan_version_id, status, started_at, created_by)
       VALUES ($1, $2, $3, 'QUEUED', NOW(), $4)
       RETURNING *`,
      [workspaceId, projectId, planVersionId, userId],
    );

    const run = runRes.rows[0];

    // Seed initial batches for worker processing
    const batchSize = version.execution_config_json?.batchSize || 1000;
    const scope = version.scope_json || {};
    const rawTables = scope.tables || scope.collections || [];
    const tables: Array<{ source: string; destination: string }> =
      Array.isArray(rawTables) && rawTables.length > 0
        ? rawTables.map((t: any) =>
            typeof t === 'string'
              ? { source: t, destination: t }
              : { source: t.source || t.name, destination: t.destination || t.source || t.name },
          )
        : [
            {
              source: scope.sourceObject || 'customers',
              destination: scope.destinationObject || 'customers',
            },
          ];
    const rawMode = String(version.execution_config_json?.writeMode || 'upsert').toLowerCase();
    const writeMode: 'insert_only' | 'upsert' | 'skip_existing' =
      rawMode === 'insert_only' || rawMode === 'skip_existing' ? (rawMode as any) : 'upsert';

    const payloads: MigrationJobPayload[] = [];
    let overallSeq = 0;

    // Support dynamic streaming: if batchesPerTable is not explicitly configured,
    // seed initial streaming batch (seq 1, cursorStart = null) per collection/table.
    // The worker's streaming scheduler (onNextBatchScheduled) continues reading dynamically.
    const explicitBatchesPerTable = version.execution_config_json?.batchesPerTable;

    for (const table of tables) {
      const sourceObject = table.source;
      const destinationObject = table.destination;
      const numBatches = explicitBatchesPerTable || 1;

      for (let i = 1; i <= numBatches; i++) {
        overallSeq++;
        const batchKey =
          tables.length > 1
            ? `batch_${sourceObject}_${String(i).padStart(4, '0')}`
            : `batch_${String(i).padStart(4, '0')}`;

        // Insert batch in PENDING state (Transactional Outbox Pattern)
        await this.db.query(
          `INSERT INTO migration_batches (
             migration_run_id, batch_key, sequence_no, status,
             records_read, records_written, records_skipped, records_failed
           )
           VALUES ($1, $2, $3, 'PENDING', 0, 0, 0, 0)`,
          [run.id, batchKey, overallSeq],
        );

        payloads.push({
          jobId: `${run.id}_${batchKey}`,
          migrationRunId: run.id,
          batchKey,
          sequenceNo: overallSeq,
          sourceObject,
          destinationObject,
          cursorStart: i === 1 ? null : { offset: (i - 1) * batchSize },
          cursorEnd: explicitBatchesPerTable ? { offset: i * batchSize } : undefined,
          batchSize,
          planVersionId,
          mappingVersionId: version.mapping_version_id || 'default-mapping',
          writeMode,
          sourceConnectionId: version.source_connection_id,
          destinationConnectionId: version.destination_connection_id,
        });
      }
    }

    // Execute transactional outbox dispatch: pending batches are queued to BullMQ and transitioned to QUEUED
    await this.dispatchPendingOutboxBatches(run.id);

    // Append to audit events
    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
       VALUES ($1, $2, 'USER', $3, 'MIGRATION_RUN_STARTED', 'MIGRATION_RUN', $4, $5)`,
      [
        workspaceId,
        projectId,
        userId,
        run.id,
        { planVersionId, planHash: version.plan_hash },
      ],
    );

    return {
      runId: run.id,
      status: 'QUEUED',
      planHash: version.plan_hash,
      createdAt: run.created_at,
    };
  }

  /**
   * Transactional Outbox Dispatcher: queries all PENDING batches for a run,
   * dispatches them to BullMQ, and idempotently updates their status to QUEUED.
   */
  async dispatchPendingOutboxBatches(runId: string): Promise<number> {
    const res = await this.db.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 AND status = 'PENDING' ORDER BY sequence_no ASC`,
      [runId],
    );
    if (res.rows.length === 0 || !this.queueService) return 0;

    const planRes = await this.db.query(
      `SELECT mpv.* FROM migration_plan_versions mpv
       JOIN migration_runs mr ON mr.plan_version_id = mpv.id
       WHERE mr.id = $1`,
      [runId],
    );
    const version = planRes.rows[0];
    const batchSize = version?.execution_config_json?.batchSize || 1000;
    const writeMode = version?.execution_config_json?.writeMode || 'upsert';

    const payloads: MigrationJobPayload[] = res.rows.map((b: any) => ({
      jobId: b.attempt_count > 0 ? `${runId}_${b.batch_key}_att${b.attempt_count}` : `${runId}_${b.batch_key}`,
      migrationRunId: runId,
      batchKey: b.batch_key,
      sequenceNo: Number(b.sequence_no),
      sourceObject: b.source_object || 'customers',
      destinationObject: b.destination_object || 'customers',
      cursorStart: b.source_cursor_start || null,
      cursorEnd: b.source_cursor_end || null,
      batchSize,
      planVersionId: version?.id || '',
      mappingVersionId: version?.mapping_version_id || 'default-mapping',
      writeMode,
      sourceConnectionId: version?.source_connection_id,
      destinationConnectionId: version?.destination_connection_id,
    }));

    await this.queueService.dispatchBatches(payloads);
    await this.db.query(
      `UPDATE migration_batches SET status = 'QUEUED' WHERE migration_run_id = $1 AND status = 'PENDING'`,
      [runId],
    );
    return payloads.length;
  }

  async listRuns(workspaceId: string, userId: string) {
    const wsId = await this.workspaceService.resolveWorkspaceId(workspaceId, userId);
    await this.workspaceService.assertWorkspaceAccess(wsId, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT mr.*, p.name as project_name, mpv.version as plan_version
       FROM migration_runs mr
       LEFT JOIN projects p ON mr.project_id = p.id
       LEFT JOIN migration_plan_versions mpv ON mr.plan_version_id = mpv.id
       WHERE mr.workspace_id = $1
       ORDER BY mr.created_at DESC`,
      [wsId],
    );
    return res.rows;
  }

  async getRun(runId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM migration_runs WHERE id = $1', [runId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Migration run not found.');
    }
    const run = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Viewer');
    return run;
  }

  async listBatches(runId: string, page = 1, limit = 20, userId: string) {
    const run = await this.getRun(runId, userId);
    const offset = (page - 1) * limit;

    const res = await this.db.query(
      `SELECT * FROM migration_batches
       WHERE migration_run_id = $1
       ORDER BY sequence_no ASC
       LIMIT $2 OFFSET $3`,
      [runId, limit, offset],
    );

    const countRes = await this.db.query(
      'SELECT COUNT(*) as count FROM migration_batches WHERE migration_run_id = $1',
      [runId],
    );

    return {
      batches: res.rows,
      pagination: {
        total: parseInt(countRes.rows[0].count, 10),
        page,
        limit,
      },
    };
  }

  async getBatch(runId: string, batchId: string, userId: string) {
    await this.getRun(runId, userId);
    const res = await this.db.query(
      'SELECT * FROM migration_batches WHERE migration_run_id = $1 AND id = $2',
      [runId, batchId],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException('Batch not found.');
    }
    return res.rows[0];
  }

  async pauseRun(runId: string, userId: string) {
    const run = await this.getRun(runId, userId);
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Engineer');

    if (run.status === 'COMPLETED' || run.status === 'CANCELLED') {
      throw new ConflictException(`Cannot pause run in terminal state: ${run.status}`);
    }

    await this.db.query('UPDATE migration_runs SET status = $1, updated_at = NOW() WHERE id = $2', [
      'PAUSED',
      runId,
    ]);

    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'USER', $3, 'MIGRATION_RUN_PAUSED', 'MIGRATION_RUN', $4)`,
      [run.workspace_id, run.project_id, userId, runId],
    );

    return { runId, status: 'PAUSED', message: 'Migration run paused successfully.' };
  }

  async resumeRun(runId: string, userId: string) {
    const run = await this.getRun(runId, userId);
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Engineer');

    if (run.status !== 'PAUSED') {
      throw new ConflictException(`Can only resume runs in PAUSED state. Current status: ${run.status}`);
    }

    await this.db.query('UPDATE migration_runs SET status = $1, updated_at = NOW() WHERE id = $2', [
      'RUNNING',
      runId,
    ]);

    // Dispatch any pending outbox batches that were not yet queued
    await this.dispatchPendingOutboxBatches(runId);

    // Re-dispatch any paused or retry batches
    const pausedBatches = await this.db.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 AND status IN ('PAUSED', 'RETRY_WAIT') ORDER BY sequence_no ASC`,
      [runId],
    );

    if (this.queueService && pausedBatches.rows.length > 0) {
      const planRes = await this.db.query(
        `SELECT mpv.* FROM migration_plan_versions mpv
         JOIN migration_runs mr ON mr.plan_version_id = mpv.id
         WHERE mr.id = $1`,
        [runId],
      );
      const version = planRes.rows[0];
      const batchSize = version?.execution_config_json?.batchSize || 1000;
      const writeMode = version?.execution_config_json?.writeMode || 'upsert';

      const resumePayloads: MigrationJobPayload[] = pausedBatches.rows.map((b: any) => ({
        jobId: `${runId}_${b.batch_key}_resumed_${Date.now()}_att${b.attempt_count + 1}`,
        migrationRunId: runId,
        batchKey: b.batch_key,
        sequenceNo: Number(b.sequence_no),
        sourceObject: b.source_object || 'customers',
        destinationObject: b.destination_object || 'customers',
        cursorStart: b.source_cursor_start || null,
        cursorEnd: b.source_cursor_end || null,
        batchSize,
        planVersionId: version?.id || '',
        mappingVersionId: version?.mapping_version_id || 'default-mapping',
        writeMode,
        sourceConnectionId: version?.source_connection_id,
        destinationConnectionId: version?.destination_connection_id,
      }));

      await this.queueService.dispatchBatches(resumePayloads);
      await this.db.query(
        `UPDATE migration_batches SET status = 'QUEUED', attempt_count = attempt_count + 1 WHERE migration_run_id = $1 AND status IN ('PAUSED', 'RETRY_WAIT')`,
        [runId],
      );
    }

    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'USER', $3, 'MIGRATION_RUN_RESUMED', 'MIGRATION_RUN', $4)`,
      [run.workspace_id, run.project_id, userId, runId],
    );

    return { runId, status: 'RUNNING', message: 'Migration run resumed.' };
  }

  async cancelRun(runId: string, userId: string) {
    const run = await this.getRun(runId, userId);
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Engineer');

    if (run.status === 'COMPLETED') {
      throw new ConflictException('Cannot cancel an already completed run.');
    }

    await this.db.query(
      'UPDATE migration_runs SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['CANCELLED', runId],
    );

    await this.db.query(
      `UPDATE migration_batches SET status = 'CANCELLED' WHERE migration_run_id = $1 AND status NOT IN ('COMMITTED', 'FAILED_PERMANENT')`,
      [runId],
    );

    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'USER', $3, 'MIGRATION_RUN_CANCELLED', 'MIGRATION_RUN', $4)`,
      [run.workspace_id, run.project_id, userId, runId],
    );

    return { runId, status: 'CANCELLED', message: 'Migration run cancelled.' };
  }

  async retryFailed(runId: string, userId: string) {
    const run = await this.getRun(runId, userId);
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Engineer');

    // Reset failed batches to QUEUED
    const res = await this.db.query(
      `UPDATE migration_batches
       SET status = 'QUEUED', attempt_count = attempt_count + 1
       WHERE migration_run_id = $1 AND status IN ('FAILED_RETRYABLE', 'RETRY_WAIT')
       RETURNING *`,
      [runId],
    );

    // Re-dispatch reset batches to BullMQ
    if (this.queueService && res.rows.length > 0) {
      const planRes = await this.db.query(
        `SELECT mpv.* FROM migration_plan_versions mpv
         JOIN migration_runs mr ON mr.plan_version_id = mpv.id
         WHERE mr.id = $1`,
        [runId],
      );
      const version = planRes.rows[0];
      const batchSize = version?.execution_config_json?.batchSize || 1000;
      const scope = version?.scope_json || {};
      const sourceObject = scope.sourceObject || 'customers';
      const destinationObject = scope.destinationObject || 'customers';
      const writeMode = version?.execution_config_json?.writeMode || 'upsert';

      const retryPayloads: MigrationJobPayload[] = res.rows.map((b: any) => ({
        jobId: `${runId}_${b.batch_key}_retry_${b.attempt_count}`,
        migrationRunId: runId,
        batchKey: b.batch_key,
        sequenceNo: Number(b.sequence_no),
        sourceObject,
        destinationObject,
        cursorStart: b.source_cursor_start || null,
        cursorEnd: b.source_cursor_end || null,
        batchSize,
        planVersionId: version?.id || '',
        mappingVersionId: version?.mapping_version_id || 'default-mapping',
        writeMode,
        sourceConnectionId: version?.source_connection_id,
        destinationConnectionId: version?.destination_connection_id,
      }));

      await this.queueService.dispatchBatches(retryPayloads);
    }

    return {
      runId,
      retriedBatchesCount: res.rowCount,
      message: `Re-queued ${res.rowCount} failed batches for processing.`,
    };
  }

  async getEvents(runId: string, userId: string) {
    const run = await this.getRun(runId, userId);
    const res = await this.db.query(
      `SELECT * FROM audit_events
       WHERE resource_type = 'MIGRATION_RUN' AND resource_id = $1
       ORDER BY created_at DESC`,
      [runId],
    );
    return res.rows;
  }
}
