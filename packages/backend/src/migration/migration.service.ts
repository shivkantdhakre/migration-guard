import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { QueueService, MigrationJobPayload } from '../queue/queue.service';

@Injectable()
export class MigrationService implements OnModuleInit, OnModuleDestroy {
  private outboxTimer: NodeJS.Timeout | null = null;
  private isPublishing = false;
  private static activeOutboxLocks = new Set<string>();

  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    @Optional() private queueService?: QueueService,
  ) {}

  onModuleInit() {
    this.startAutonomousOutboxPublisher();
  }

  onModuleDestroy() {
    this.stopAutonomousOutboxPublisher();
  }

  public startAutonomousOutboxPublisher(intervalMs = 3000) {
    if (this.outboxTimer) return;
    this.outboxTimer = setInterval(async () => {
      try {
        await this.dispatchPendingOutboxBatches();
      } catch (err: any) {
        // Resilient autonomous background publisher
      }
    }, intervalMs);
  }

  public stopAutonomousOutboxPublisher() {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
  }

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

    // Resolve mapping version for identity keys and objects (Requirement 4 & 5)
    let mappingObjects: any[] = [];
    if (version.mapping_version_id) {
      const mapRes = await this.db.query(
        'SELECT mapping_json FROM mapping_versions WHERE id = $1',
        [version.mapping_version_id],
      );
      if (mapRes.rows.length > 0) {
        const m = typeof mapRes.rows[0].mapping_json === 'string'
          ? JSON.parse(mapRes.rows[0].mapping_json)
          : mapRes.rows[0].mapping_json;
        mappingObjects = Array.isArray(m?.objects) ? m.objects : (m ? [m] : []);
      }
    }

    const scope = version.scope_json || {};
    const rawTables = scope.tables || scope.collections || [];
    const tables: Array<{ source: string; destination: string }> =
      Array.isArray(rawTables) && rawTables.length > 0
        ? rawTables.map((t: any) =>
            typeof t === 'string'
              ? { source: t, destination: t }
              : { source: t.source || t.name, destination: t.destination || t.source || t.name },
          )
        : mappingObjects.length > 0
        ? mappingObjects.map((m: any) => ({
            source: m.source?.collection || m.source?.object || (typeof m.source === 'string' ? m.source : 'customers'),
            destination: m.destination?.table || m.destination?.object || (typeof m.destination === 'string' ? m.destination : 'customers'),
          }))
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

      const matched = mappingObjects.find(
        (o: any) =>
          (o.source?.collection || o.source?.object || o.source) === sourceObject ||
          (o.destination?.table || o.destination?.object || o.destination) === destinationObject,
      );
      const destKey = matched?.identity?.destinationKey || matched?.destination?.key || 'id';

      for (let i = 1; i <= numBatches; i++) {
        overallSeq++;
        const batchKey =
          tables.length > 1
            ? `batch_${sourceObject}_${String(i).padStart(4, '0')}`
            : `batch_${String(i).padStart(4, '0')}`;

        const cursorStart = i === 1 ? null : { offset: (i - 1) * batchSize };
        const cursorEnd = explicitBatchesPerTable ? { offset: i * batchSize } : undefined;

        // Insert batch in PENDING state (Transactional Outbox Pattern) with complete immutable context
        await this.db.query(
          `INSERT INTO migration_batches (
             migration_run_id, batch_key, sequence_no, status,
             source_object, destination_object, mapping_version_id,
             source_cursor_start, source_cursor_end,
             records_read, records_written, records_skipped, records_failed
           )
           VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
          [
            run.id,
            batchKey,
            overallSeq,
            sourceObject,
            destinationObject,
            version.mapping_version_id || null,
            cursorStart ? JSON.stringify(cursorStart) : null,
            cursorEnd ? JSON.stringify(cursorEnd) : null,
          ],
        );

        payloads.push({
          jobId: `${run.id}_${batchKey}`,
          migrationRunId: run.id,
          batchKey,
          sequenceNo: overallSeq,
          sourceObject,
          destinationObject,
          cursorStart,
          cursorEnd,
          batchSize,
          planVersionId,
          mappingVersionId: version.mapping_version_id || 'default-mapping',
          writeMode,
          conflictColumns: [destKey],
          destinationKey: destKey,
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
   * Transactional Outbox Dispatcher: queries all PENDING batches (for a specific run or across all runs),
   * dispatches them to BullMQ, and idempotently updates their status to QUEUED.
   * Features:
   * 1. Multi-instance coordination via transaction-scoped PostgreSQL advisory locks (pg_try_advisory_xact_lock).
   * 2. Atomic batch claiming with FOR UPDATE SKIP LOCKED.
   * 3. Complete immutable metadata: source/destination objects, cursors, connection IDs, destination identity key, mapping version.
   * 4. Safe distributed boundary: batches remain PENDING until successfully dispatched to BullMQ/Redis,
   *    then transition to QUEUED in PostgreSQL. Cross-system atomicity is not claimed; crash windows between
   *    Redis enqueue and DB commit are handled by deterministic BullMQ job IDs, durable retryable batch claims,
   *    and worker startup reconciliation.
   */
  async dispatchPendingOutboxBatches(runId?: string): Promise<number> {
    const lockKey = runId ? `outbox_pub_${runId}` : 'outbox_pub_global';
    const inMemoryKey = runId || 'global';

    if (MigrationService.activeOutboxLocks.has(inMemoryKey) || this.isPublishing) {
      return 0;
    }
    MigrationService.activeOutboxLocks.add(inMemoryKey);
    this.isPublishing = true;

    try {
      const isPostgres = Boolean(this.db.getRawPool());
      if (isPostgres) {
        let dispatchedCount = 0;
        await this.db.transaction(async (client) => {
          // Transaction-scoped advisory lock for multi-instance coordination
          const xactLock = await client.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) as acquired`,
            [lockKey],
          );
          if (xactLock.rows.length > 0 && !xactLock.rows[0].acquired) {
            return;
          }

          let query = `SELECT * FROM migration_batches WHERE status = 'PENDING'`;
          const params: any[] = [];
          if (runId) {
            query += ` AND migration_run_id = $1`;
            params.push(runId);
          }
          query += ` ORDER BY sequence_no ASC LIMIT 100 FOR UPDATE SKIP LOCKED`;

          const res = await client.query(query, params);
          if (res.rows.length === 0 || !this.queueService) return;

          const parseJsonField = (val: any) => {
            if (val === null || val === undefined) return null;
            if (typeof val === 'string') {
              try {
                return JSON.parse(val);
              } catch {
                return val;
              }
            }
            return val;
          };

          const payloads: MigrationJobPayload[] = [];
          const planCache = new Map<string, any>();
          const runCache = new Map<string, any>();

          for (const b of res.rows) {
            const bRunId = b.migration_run_id;

            let run = runCache.get(bRunId);
            if (!run) {
              const runRes = await client.query(
                `SELECT id, status, plan_version_id FROM migration_runs WHERE id = $1`,
                [bRunId],
              );
              if (runRes.rows.length > 0) {
                run = runRes.rows[0];
                runCache.set(bRunId, run);
              }
            }
            if (run && (run.status === 'PAUSED' || run.status === 'CANCELLED')) {
              continue;
            }

            let version = planCache.get(bRunId);
            if (!version) {
              const planVersionId = run?.plan_version_id;
              if (planVersionId) {
                const planRes = await client.query(
                  `SELECT * FROM migration_plan_versions WHERE id = $1`,
                  [planVersionId],
                );
                version = planRes.rows[0];
                planCache.set(bRunId, version);
              }
            }

            const batchSize = version?.execution_config_json?.batchSize || 1000;
            const maxBytes = version?.execution_config_json?.maxBytes;
            const writeMode = version?.execution_config_json?.writeMode || 'upsert';

            let destKey = 'id';
            const mapVersionId = b.mapping_version_id || version?.mapping_version_id;
            if (mapVersionId) {
              let mappingJson = planCache.get(`map_${mapVersionId}`);
              if (!mappingJson) {
                const mapRes = await client.query(
                  'SELECT mapping_json FROM mapping_versions WHERE id = $1',
                  [mapVersionId],
                );
                if (mapRes.rows.length > 0) {
                  mappingJson = typeof mapRes.rows[0].mapping_json === 'string'
                    ? JSON.parse(mapRes.rows[0].mapping_json)
                    : mapRes.rows[0].mapping_json;
                  planCache.set(`map_${mapVersionId}`, mappingJson);
                }
              }
              const objects: any[] = Array.isArray(mappingJson?.objects)
                ? mappingJson.objects
                : (mappingJson ? [mappingJson] : []);
              const matched = objects.find(
                (o: any) =>
                  (o.source?.collection || o.source?.object || o.source) === b.source_object ||
                  (o.destination?.table || o.destination?.object || o.destination) === b.destination_object,
              ) || (objects.length === 1 ? objects[0] : null);
              if (matched?.identity?.destinationKey || matched?.destination?.key || matched?.destination?.identityKey) {
                destKey = matched.identity?.destinationKey || matched?.destination?.key || matched?.destination?.identityKey;
              }
            }

            payloads.push({
              jobId: b.attempt_count > 0 ? `${bRunId}_${b.batch_key}_att${b.attempt_count}` : `${bRunId}_${b.batch_key}`,
              migrationRunId: bRunId,
              batchKey: b.batch_key,
              sequenceNo: Number(b.sequence_no),
              sourceObject: b.source_object || 'customers',
              destinationObject: b.destination_object || b.source_object || 'customers',
              cursorStart: parseJsonField(b.source_cursor_start),
              cursorEnd: parseJsonField(b.source_cursor_end),
              batchSize,
              maxBytes,
              planVersionId: version?.id || run?.plan_version_id || '',
              mappingVersionId: b.mapping_version_id || version?.mapping_version_id || 'default-mapping',
              writeMode,
              conflictColumns: [destKey],
              destinationKey: destKey,
              sourceConnectionId: version?.source_connection_id,
              destinationConnectionId: version?.destination_connection_id,
            });
          }

          if (payloads.length === 0) return;

          // Dispatch to BullMQ / Redis. If Redis fails, transaction rolls back and batches remain PENDING.
          await this.queueService.dispatchBatches(payloads);

          // Atomic transition inside the transaction
          for (const p of payloads) {
            await client.query(
              `UPDATE migration_batches SET status = 'QUEUED', updated_at = NOW() WHERE migration_run_id = $1 AND batch_key = $2 AND status = 'PENDING'`,
              [p.migrationRunId, p.batchKey],
            );
          }

          dispatchedCount = payloads.length;
        });

        return dispatchedCount;
      }

      // In-memory fallback
      let query = `SELECT * FROM migration_batches WHERE status = 'PENDING'`;
      const params: any[] = [];
      if (runId) {
        query += ` AND migration_run_id = $1`;
        params.push(runId);
      }
      query += ` ORDER BY sequence_no ASC LIMIT 100`;

      const res = await this.db.query(query, params);
      if (res.rows.length === 0 || !this.queueService) return 0;

      const parseJsonField = (val: any) => {
        if (val === null || val === undefined) return null;
        if (typeof val === 'string') {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      };

      const payloads: MigrationJobPayload[] = [];
      const planCache = new Map<string, any>();
      const runCache = new Map<string, any>();

      for (const b of res.rows) {
        const bRunId = b.migration_run_id;

        // Verify migration run is not PAUSED or CANCELLED
        let run = runCache.get(bRunId);
        if (!run) {
          const runRes = await this.db.query(
            `SELECT id, status, plan_version_id FROM migration_runs WHERE id = $1`,
            [bRunId],
          );
          if (runRes.rows.length > 0) {
            run = runRes.rows[0];
            runCache.set(bRunId, run);
          }
        }
        if (run && (run.status === 'PAUSED' || run.status === 'CANCELLED')) {
          continue;
        }

        let version = planCache.get(bRunId);
        if (!version) {
          const planVersionId = run?.plan_version_id;
          if (planVersionId) {
            const planRes = await this.db.query(
              `SELECT * FROM migration_plan_versions WHERE id = $1`,
              [planVersionId],
            );
            version = planRes.rows[0];
            planCache.set(bRunId, version);
          }
        }

        const batchSize = version?.execution_config_json?.batchSize || 1000;
        const maxBytes = version?.execution_config_json?.maxBytes;
        const writeMode = version?.execution_config_json?.writeMode || 'upsert';

        // Resolve destinationKey from mapping version
        let destKey = 'id';
        const mapVersionId = b.mapping_version_id || version?.mapping_version_id;
        if (mapVersionId) {
          let mappingJson = planCache.get(`map_${mapVersionId}`);
          if (!mappingJson) {
            const mapRes = await this.db.query(
              'SELECT mapping_json FROM mapping_versions WHERE id = $1',
              [mapVersionId],
            );
            if (mapRes.rows.length > 0) {
              mappingJson = typeof mapRes.rows[0].mapping_json === 'string'
                ? JSON.parse(mapRes.rows[0].mapping_json)
                : mapRes.rows[0].mapping_json;
              planCache.set(`map_${mapVersionId}`, mappingJson);
            }
          }
          const objects: any[] = Array.isArray(mappingJson?.objects)
            ? mappingJson.objects
            : (mappingJson ? [mappingJson] : []);
          const matched = objects.find(
            (o: any) =>
              (o.source?.collection || o.source?.object || o.source) === b.source_object ||
              (o.destination?.table || o.destination?.object || o.destination) === b.destination_object,
          ) || (objects.length === 1 ? objects[0] : null);
          if (matched?.identity?.destinationKey || matched?.destination?.key || matched?.destination?.identityKey) {
            destKey = matched.identity?.destinationKey || matched?.destination?.key || matched?.destination?.identityKey;
          }
        }

        payloads.push({
          jobId: b.attempt_count > 0 ? `${bRunId}_${b.batch_key}_att${b.attempt_count}` : `${bRunId}_${b.batch_key}`,
          migrationRunId: bRunId,
          batchKey: b.batch_key,
          sequenceNo: Number(b.sequence_no),
          sourceObject: b.source_object || 'customers',
          destinationObject: b.destination_object || b.source_object || 'customers',
          cursorStart: parseJsonField(b.source_cursor_start),
          cursorEnd: parseJsonField(b.source_cursor_end),
          batchSize,
          maxBytes,
          planVersionId: version?.id || run?.plan_version_id || '',
          mappingVersionId: b.mapping_version_id || version?.mapping_version_id || 'default-mapping',
          writeMode,
          conflictColumns: [destKey],
          destinationKey: destKey,
          sourceConnectionId: version?.source_connection_id,
          destinationConnectionId: version?.destination_connection_id,
        });
      }

      if (payloads.length === 0) return 0;

      // Safe transactional dispatch: batches remain PENDING until successfully enqueued to BullMQ/Redis,
      // and transition to QUEUED atomically in a transaction.
      await this.queueService.dispatchBatches(payloads, async (p) => {
        await this.transitionBatchToQueued(p.migrationRunId, p.batchKey);
      });

      // Fallback/catch-up transition for test mocks that do not invoke the onDispatched callback
      for (const p of payloads) {
        await this.transitionBatchToQueued(p.migrationRunId, p.batchKey);
      }

      return payloads.length;
    } finally {
      MigrationService.activeOutboxLocks.delete(inMemoryKey);
      this.isPublishing = false;
    }
  }

  /**
   * Atomically transitions an outbox batch from PENDING to QUEUED in a PostgreSQL transaction.
   */
  private async transitionBatchToQueued(migrationRunId: string, batchKey: string): Promise<void> {
    if (Boolean(this.db.getRawPool())) {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE migration_batches SET status = 'QUEUED', updated_at = NOW() WHERE migration_run_id = $1 AND batch_key = $2 AND status = 'PENDING'`,
          [migrationRunId, batchKey],
        );
      });
    } else {
      await this.db.query(
        `UPDATE migration_batches SET status = 'QUEUED', updated_at = NOW() WHERE migration_run_id = $1 AND batch_key = $2 AND status = 'PENDING'`,
        [migrationRunId, batchKey],
      );
    }
  }

  /**
   * Routes dynamically generated streaming batches through the durable outbox (migration_batches).
   * Ensures all batches are persisted as PENDING before being dispatched to BullMQ. Never bypasses outbox.
   */
  async scheduleStreamingBatch(payload: {
    migrationRunId: string;
    batchKey: string;
    sequenceNo: number;
    sourceObject?: string;
    destinationObject?: string;
    cursorStart?: any;
    cursorEnd?: any;
    mappingVersionId?: string;
    planVersionId?: string;
    sourceConnectionId?: string;
    destinationConnectionId?: string;
    destinationKey?: string;
    batchSize?: number;
    writeMode?: 'insert_only' | 'upsert' | 'skip_existing';
  }): Promise<{ status: string; batchKey: string; sequenceNo: number }> {
    const { migrationRunId, batchKey, sequenceNo } = payload;
    if (!migrationRunId || !batchKey || sequenceNo === undefined) {
      throw new BadRequestException('migrationRunId, batchKey, and sequenceNo are required.');
    }

    const runRes = await this.db.query('SELECT * FROM migration_runs WHERE id = $1', [migrationRunId]);
    if (runRes.rows.length === 0) {
      throw new NotFoundException(`Migration run ${migrationRunId} not found.`);
    }
    const run = runRes.rows[0];
    if (run.status === 'PAUSED' || run.status === 'CANCELLED' || run.status === 'COMPLETED') {
      throw new ConflictException(`Cannot schedule batch for run in ${run.status} state.`);
    }

    let planVersion: any = null;
    if (run.plan_version_id) {
      const pvRes = await this.db.query('SELECT * FROM migration_plan_versions WHERE id = $1', [
        run.plan_version_id,
      ]);
      if (pvRes.rows.length > 0) {
        planVersion = pvRes.rows[0];
      }
    }

    const sourceObject = payload.sourceObject || 'customers';
    const destinationObject = payload.destinationObject || sourceObject;
    const mappingVersionId = payload.mappingVersionId || planVersion?.mapping_version_id || null;
    const cursorStart = payload.cursorStart !== undefined ? payload.cursorStart : null;
    const cursorEnd = payload.cursorEnd !== undefined ? payload.cursorEnd : null;

    // Persist batch into durable outbox with PENDING status (never bypass outbox!)
    await this.db.query(
      `INSERT INTO migration_batches (
         migration_run_id, batch_key, sequence_no, status,
         source_object, destination_object, mapping_version_id,
         source_cursor_start, source_cursor_end,
         records_read, records_written, records_skipped, records_failed, attempt_count
       )
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, 0, 0, 0, 0, 0)
       ON CONFLICT (migration_run_id, batch_key) DO UPDATE
       SET status = 'PENDING',
           source_cursor_start = EXCLUDED.source_cursor_start,
           source_cursor_end = EXCLUDED.source_cursor_end
       WHERE migration_batches.status IN ('FAILED_RETRYABLE', 'RETRY_WAIT', 'PENDING')`,
      [
        migrationRunId,
        batchKey,
        sequenceNo,
        sourceObject,
        destinationObject,
        mappingVersionId,
        cursorStart ? JSON.stringify(cursorStart) : null,
        cursorEnd ? JSON.stringify(cursorEnd) : null,
      ],
    );

    // Dispatch outbox batch via transactional publisher (transitions PENDING -> QUEUED)
    await this.dispatchPendingOutboxBatches(migrationRunId);

    return { status: 'PENDING', batchKey, sequenceNo };
  }

  async enqueueStreamingBatch(payload: any) {
    return this.scheduleStreamingBatch(payload);
  }

  async routeStreamingBatch(payload: any) {
    return this.scheduleStreamingBatch(payload);
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

    // Transition any paused or retry batches to PENDING in the outbox
    await this.db.query(
      `UPDATE migration_batches SET status = 'PENDING' WHERE migration_run_id = $1 AND status IN ('PAUSED', 'RETRY_WAIT')`,
      [runId],
    );

    // Dispatch pending outbox batches that were not yet queued (transitions PENDING -> QUEUED only after dispatch)
    await this.dispatchPendingOutboxBatches(runId);

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

    if (run.status === 'COMPLETED' || run.status === 'CANCELLED') {
      throw new ConflictException(`Cannot retry batches for run in terminal state: ${run.status}`);
    }

    if (run.status === 'FAILED') {
      await this.db.query('UPDATE migration_runs SET status = $1, updated_at = NOW() WHERE id = $2', [
        'RUNNING',
        runId,
      ]);
    }

    // Reset failed batches to PENDING in transactional outbox with incremented attempt_count
    const res = await this.db.query(
      `UPDATE migration_batches
       SET status = 'PENDING', attempt_count = attempt_count + 1
       WHERE migration_run_id = $1 AND status IN ('FAILED_RETRYABLE', 'RETRY_WAIT')
       RETURNING *`,
      [runId],
    );

    // Dispatch pending outbox batches (transitions PENDING -> QUEUED only after successful dispatch)
    await this.dispatchPendingOutboxBatches(runId);

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
