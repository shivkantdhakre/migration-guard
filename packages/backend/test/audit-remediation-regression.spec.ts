import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { AuthService } from '../src/auth/auth.service';
import { ConnectionService } from '../src/connection/connection.service';
import { SchemaService } from '../src/schema/schema.service';
import { PlanService } from '../src/plan/plan.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { ReadinessService } from '../src/plan/readiness.service';
import { MigrationService } from '../src/migration/migration.service';
import { ValidationService } from '../src/validation/validation.service';
import { ToolCatalog } from '../src/ai/tools/tool-catalog';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import { BadRequestException, ConflictException } from '@nestjs/common';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe('Audit Remediation Comprehensive Regression Suite', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let authService: AuthService;
  let connectionService: ConnectionService;
  let schemaService: SchemaService;
  let planService: PlanService;
  let dryRunService: DryRunService;
  let readinessService: ReadinessService;
  let migrationService: MigrationService;
  let validationService: ValidationService;

  let workspaceA: any;
  let workspaceB: any;
  let userA: any;
  let userB: any;
  let sourceConnA: any;
  let destConnA: any;

  beforeAll(async () => {
    db = new DatabaseService();
    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    const mockCreds = {
      storeCredentials: async () => {},
      getDecryptedCredentials: async () => ({ connectionString: 'postgresql://localhost:5432/mock' }),
      rotateCredentials: async () => ({ newVersion: 1 }),
    };

    connectionService = new ConnectionService(db, workspaceService, mockCreds as any);
    schemaService = new SchemaService(db, connectionService, workspaceService, mockCreds as any);
    planService = new PlanService(db, workspaceService, projectService);
    dryRunService = new DryRunService(db, workspaceService, mockCreds as any);
    readinessService = new ReadinessService(db, workspaceService, connectionService);
    migrationService = new MigrationService(db, workspaceService);
    validationService = new ValidationService(db, workspaceService, mockCreds as any);

    ToolCatalog.setDatabaseService(db);

    const emailA = `audit_reg_a_${Date.now()}@example.com`;
    const emailB = `audit_reg_b_${Date.now()}@example.com`;
    userA = await authService.register(emailA, 'Password123!', 'Tenant A');
    userB = await authService.register(emailB, 'Password123!', 'Tenant B');
    workspaceA = userA.workspace;
    workspaceB = userB.workspace;

    const sConnRes = await db.query(
      `INSERT INTO connections (workspace_id, name, engine, role, connection_role, config_json, status)
       VALUES ($1, 'Source Mongo A', 'MONGODB', 'SOURCE', 'SOURCE', '{}', 'HEALTHY') RETURNING *`,
      [workspaceA.id],
    );
    sourceConnA = sConnRes.rows[0];

    const dConnRes = await db.query(
      `INSERT INTO connections (workspace_id, name, engine, role, connection_role, config_json, status)
       VALUES ($1, 'Dest PG A', 'POSTGRESQL', 'DESTINATION', 'DESTINATION', '{}', 'HEALTHY') RETURNING *`,
      [workspaceA.id],
    );
    destConnA = dConnRes.rows[0];
  });

  afterAll(async () => {
    if (db && typeof (db as any).onModuleDestroy === 'function') {
      await (db as any).onModuleDestroy();
    }
  });

  describe('1. Concurrent Outbox Publishers Across Multiple Instances', () => {
    it('prevents duplicate batch claims and dispatches using locking and SKIP LOCKED', async () => {
      let dispatchCount = 0;
      const mockQueue = {
        isQueueConnected: true,
        dispatchBatches: async (payloads: any[]) => {
          dispatchCount += payloads.length;
          return payloads.map((p) => `job_${p.batchKey}`);
        },
      };

      const instance1 = new MigrationService(db, workspaceService, mockQueue as any);
      const instance2 = new MigrationService(db, workspaceService, mockQueue as any);

      const runRes = await db.query(
        `INSERT INTO migration_runs (workspace_id, status, source_connection_id, destination_connection_id)
         VALUES ($1, 'RUNNING', $2, $3) RETURNING id`,
        [workspaceA.id, sourceConnA.id, destConnA.id],
      );
      const runId = runRes.rows[0].id;

      for (let i = 1; i <= 5; i++) {
        await db.query(
          `INSERT INTO migration_batches (migration_run_id, batch_key, sequence_no, status, source_object, destination_object)
           VALUES ($1, $2, $3, 'PENDING', 'orders', 'orders')`,
          [runId, `batch_concurrent_${i}`, i],
        );
      }

      const [res1, res2] = await Promise.all([
        instance1.dispatchPendingOutboxBatches(runId),
        instance2.dispatchPendingOutboxBatches(runId),
      ]);

      expect(res1 + res2).toBe(5);
      expect(dispatchCount).toBe(5);

      const checkRes = await db.query(
        `SELECT status FROM migration_batches WHERE migration_run_id = $1`,
        [runId],
      );
      expect(checkRes.rows.every((r: any) => r.status === 'QUEUED')).toBe(true);
    });
  });

  describe('2. Redis Failures, Safe Retries, and Terminal Run Protection', () => {
    it('keeps batches in PENDING state when Redis dispatch fails or queue throws', async () => {
      const failingQueue = {
        isQueueConnected: true,
        dispatchBatches: async () => {
          throw new Error('Redis connection lost ECONNREFUSED');
        },
      };

      const service = new MigrationService(db, workspaceService, failingQueue as any);
      const runRes = await db.query(
        `INSERT INTO migration_runs (workspace_id, status, source_connection_id, destination_connection_id)
         VALUES ($1, 'RUNNING', $2, $3) RETURNING id`,
        [workspaceA.id, sourceConnA.id, destConnA.id],
      );
      const runId = runRes.rows[0].id;

      await db.query(
        `INSERT INTO migration_batches (migration_run_id, batch_key, sequence_no, status, source_object, destination_object)
         VALUES ($1, 'batch_redis_fail', 1, 'PENDING', 'users', 'users')`,
        [runId],
      );

      await expect(service.dispatchPendingOutboxBatches(runId)).rejects.toThrow();

      const batchRes = await db.query(
        `SELECT status FROM migration_batches WHERE migration_run_id = $1 AND batch_key = 'batch_redis_fail'`,
        [runId],
      );
      expect(batchRes.rows[0].status).toBe('PENDING');
    });

    it('blocks retry on terminal states (COMPLETED, CANCELLED) and reactivates FAILED runs on retry', async () => {
      const runCompleted = await db.query(
        `INSERT INTO migration_runs (workspace_id, status, source_connection_id, destination_connection_id)
         VALUES ($1, 'COMPLETED', $2, $3) RETURNING id`,
        [workspaceA.id, sourceConnA.id, destConnA.id],
      );
      await expect(
        migrationService.retryFailed(runCompleted.rows[0].id, userA.user.id),
      ).rejects.toThrow(ConflictException);

      const runFailed = await db.query(
        `INSERT INTO migration_runs (workspace_id, status, source_connection_id, destination_connection_id)
         VALUES ($1, 'FAILED', $2, $3) RETURNING id`,
        [workspaceA.id, sourceConnA.id, destConnA.id],
      );
      await db.query(
        `INSERT INTO migration_batches (migration_run_id, batch_key, sequence_no, status, source_object, destination_object, attempt_count)
         VALUES ($1, 'batch_failed_1', 1, 'FAILED_RETRYABLE', 'items', 'items', 1)`,
        [runFailed.rows[0].id],
      );

      const retryResult = await migrationService.retryFailed(runFailed.rows[0].id, userA.user.id);
      expect(retryResult.retriedBatchesCount).toBe(1);

      const recheckRun = await db.query(
        `SELECT status FROM migration_runs WHERE id = $1`,
        [runFailed.rows[0].id],
      );
      expect(recheckRun.rows[0].status).toBe('RUNNING');
    });
  });

  describe('3. Stale Schemas, Zero-Record Datasets, and Validation Evidence', () => {
    it('handles zero-record datasets safely when both source and destination are empty', async () => {
      const proj = await projectService.createProject(workspaceA.id, 'Proj Zero', undefined, userA.user.id);
      const plan = await planService.createPlan(proj.id, 'Plan Zero', userA.user.id);
      const mapRes = await db.query(
        `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
         VALUES ($1, $2, 1, '{"objects":[{"source":{"collection":"items","key":"id"},"destination":{"table":"items","key":"id"},"identity":{"sourceKey":"id","destinationKey":"id"},"fields":[{"sourcePath":"id","destinationPath":"id"}]}]}', 'hash_zero', $3) RETURNING id`,
        [workspaceA.id, plan.id, userA.user.id],
      );
      const pv = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: sourceConnA.id,
          destinationConnectionId: destConnA.id,
          mappingVersionId: mapRes.rows[0].id,
          scope: { collections: ['items'] },
        },
        userA.user.id,
      );

      const runRes = await db.query(
        `INSERT INTO migration_runs (workspace_id, plan_version_id, status, source_connection_id, destination_connection_id)
         VALUES ($1, $2, 'COMPLETED', $3, $4) RETURNING id`,
        [workspaceA.id, pv.id, sourceConnA.id, destConnA.id],
      );

      const report = await validationService.triggerValidation(runRes.rows[0].id, userA.user.id);
      expect(report.status).toBe('COMPLETED');
      expect(report.migration_run_id).toBe(runRes.rows[0].id);
    });

    it('rejects stale schema snapshot in dry run when newer snapshot exists', async () => {
      // Old snapshot v1
      const oldSnap = await db.query(
        `INSERT INTO schema_snapshots (connection_id, workspace_id, schema_version, snapshot_json, created_at)
         VALUES ($1, $2, 1, '{"tables":[]}', '2026-01-01T00:00:00Z') RETURNING id`,
        [destConnA.id, workspaceA.id],
      );
      // Newer snapshot v2
      await db.query(
        `INSERT INTO schema_snapshots (connection_id, workspace_id, schema_version, snapshot_json, created_at)
         VALUES ($1, $2, 2, '{"tables":[]}', '2026-02-01T00:00:00Z') RETURNING id`,
        [destConnA.id, workspaceA.id],
      );

      const proj = await projectService.createProject(workspaceA.id, 'Proj Stale', undefined, userA.user.id);
      const plan = await planService.createPlan(proj.id, 'Plan Stale', userA.user.id);
      const mapRes = await db.query(
        `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
         VALUES ($1, $2, 1, '{"objects":[{"source":{"collection":"items","key":"id"},"destination":{"table":"items","key":"id"},"identity":{"sourceKey":"id","destinationKey":"id"},"fields":[{"sourcePath":"id","destinationPath":"id"}]}]}', 'hash_stale', $3) RETURNING id`,
        [workspaceA.id, plan.id, userA.user.id],
      );
      const pv = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: sourceConnA.id,
          destinationConnectionId: destConnA.id,
          destinationSchemaSnapshotId: oldSnap.rows[0].id,
          mappingVersionId: mapRes.rows[0].id,
          scope: { collections: ['items'] },
        },
        userA.user.id,
      );

      const origEnv = process.env.NODE_ENV;
      const origSynth = process.env.ALLOW_SYNTHETIC_SOURCE;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_SYNTHETIC_SOURCE = 'false';
        await expect(dryRunService.startDryRun(pv.id)).rejects.toThrow(BadRequestException);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.ALLOW_SYNTHETIC_SOURCE = origSynth;
      }
    });
  });

  describe('4. Cross-Workspace Access Attempts Against Every AI Tool', () => {
    it('strictly isolates get_schema_snapshot across workspaces', async () => {
      const snapA = await db.query(
        `INSERT INTO schema_snapshots (workspace_id, schema_version, snapshot_json)
         VALUES ($1, 1, '{"tables":[{"name":"secret_a"}]}') RETURNING id`,
        [workspaceA.id],
      );
      const snapId = snapA.rows[0].id;

      const res = await ToolCatalog.executeTool({
        toolName: 'get_schema_snapshot',
        input: { snapshotId: snapId },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
      expect((res.data as any).message).toContain('not found in workspace');
    });

    it('strictly isolates get_profile_summary across workspaces', async () => {
      const snapA = await db.query(
        `INSERT INTO schema_snapshots (workspace_id, schema_version, snapshot_json)
         VALUES ($1, 1, '{"tables":[]}') RETURNING id`,
        [workspaceA.id],
      );
      await db.query(
        `INSERT INTO profile_runs (workspace_id, schema_snapshot_id, summary_json)
         VALUES ($1, $2, '{"nullPercentages":{"a":0}}')`,
        [workspaceA.id, snapA.rows[0].id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'get_profile_summary',
        input: { snapshotId: snapA.rows[0].id },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('strictly isolates get_mapping_version across workspaces', async () => {
      const proj = await projectService.createProject(workspaceA.id, 'Proj A', undefined, userA.user.id);
      const plan = await planService.createPlan(proj.id, 'Plan A', userA.user.id);
      const mapA = await db.query(
        `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
         VALUES ($1, $2, 1, '{"rules":[]}', 'hash_a', $3) RETURNING id`,
        [workspaceA.id, plan.id, userA.user.id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'get_mapping_version',
        input: { mappingVersionId: mapA.rows[0].id },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('strictly isolates get_run_summary across workspaces', async () => {
      const runA = await db.query(
        `INSERT INTO migration_runs (workspace_id, status) VALUES ($1, 'RUNNING') RETURNING id`,
        [workspaceA.id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'get_run_summary',
        input: { runId: runA.rows[0].id },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('strictly isolates get_batch_errors across workspaces', async () => {
      const runA = await db.query(
        `INSERT INTO migration_runs (workspace_id, status) VALUES ($1, 'FAILED') RETURNING id`,
        [workspaceA.id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'get_batch_errors',
        input: { runId: runA.rows[0].id },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('strictly isolates get_discrepancy_evidence across workspaces', async () => {
      const runA = await db.query(
        `INSERT INTO migration_runs (workspace_id, status) VALUES ($1, 'COMPLETED') RETURNING id`,
        [workspaceA.id],
      );
      const valA = await db.query(
        `INSERT INTO validation_runs (workspace_id, migration_run_id, status)
         VALUES ($1, $2, 'COMPLETED') RETURNING id`,
        [workspaceA.id, runA.rows[0].id],
      );
      await db.query(
        `INSERT INTO discrepancies (validation_run_id, category, severity, source_object, source_key, destination_object, destination_key, summary)
         VALUES ($1, 'FIELD_VALUE_MISMATCH', 'HIGH', 'users', 'u1', 'users', 'u1', 'Mismatch')`,
        [valA.rows[0].id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'get_discrepancy_evidence',
        input: { validationRunId: valA.rows[0].id },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('strictly isolates compare_sample_records across workspaces', async () => {
      const runA = await db.query(
        `INSERT INTO migration_runs (workspace_id, status) VALUES ($1, 'RUNNING') RETURNING id`,
        [workspaceA.id],
      );
      await db.query(
        `INSERT INTO record_manifests (migration_run_id, batch_key, source_object, source_key, destination_object, destination_key, status)
         VALUES ($1, 'b1', 'orders', 'ord_1', 'orders', 'ord_1', 'WRITTEN')`,
        [runA.rows[0].id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'compare_sample_records',
        input: { sourceRecordId: 'ord_1', destinationRecordId: 'ord_1' },
        context: { workspaceId: workspaceB.id, actorId: userB.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('NOT_FOUND');
    });

    it('returns UNAVAILABLE instead of synthesizing records when live database records cannot be fetched', async () => {
      const proj = await projectService.createProject(workspaceA.id, 'Proj Compare', undefined, userA.user.id);
      const plan = await planService.createPlan(proj.id, 'Plan Compare', userA.user.id);
      const pv = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: sourceConnA.id,
          destinationConnectionId: destConnA.id,
          scope: { collections: ['orders'] },
        },
        userA.user.id,
      );
      const runA = await db.query(
        `INSERT INTO migration_runs (workspace_id, plan_version_id, status) VALUES ($1, $2, 'RUNNING') RETURNING id`,
        [workspaceA.id, pv.id],
      );
      await db.query(
        `INSERT INTO record_manifests (migration_run_id, batch_key, source_object, source_key, destination_object, destination_key, status)
         VALUES ($1, 'b1', 'orders', 'ord_live_missing', 'orders', 'ord_live_missing', 'WRITTEN')`,
        [runA.rows[0].id],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'compare_sample_records',
        input: { sourceRecordId: 'ord_live_missing', destinationRecordId: 'ord_live_missing' },
        context: { workspaceId: workspaceA.id, actorId: userA.user.id, actorRole: 'ENGINEER' },
      });
      expect(res.success).toBe(true);
      // Must not synthesize fake records from manifest metadata; returns UNAVAILABLE when live connections/creds fail
      expect(['UNAVAILABLE', 'NOT_FOUND']).toContain((res.data as any).status);
      expect((res.data as any).matchedFields).toBeUndefined();
    });

    it('removes unscoped user fallbacks and does not attribute audit events to foreign users', async () => {
      // workspaceB context with an actorId that is a random non-member UUID
      const randomForeignActor = '44444444-4444-4444-4444-444444444444';
      const res = await ToolCatalog.executeTool({
        toolName: 'create_draft_proposal',
        input: {
          proposalType: 'MAPPING',
          content: { mapping: [] },
          rationale: 'Isolated Proposal',
        },
        context: {
          workspaceId: workspaceB.id,
          actorId: randomForeignActor,
          actorRole: 'ENGINEER',
        },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).status).toBe('DRAFT_CREATED');

      // Verify that audit events in workspaceB were only attributed to workspaceB members, never userA
      const auditRes = await db.query(
        `SELECT actor_id FROM audit_events WHERE workspace_id = $1 AND resource_id = $2`,
        [workspaceB.id, (res.data as any).proposalId],
      );
      if (auditRes.rows.length > 0) {
        expect(auditRes.rows[0].actor_id).not.toBe(userA.user.id);
      }
    });
  });

  describe('5. Readiness Connectivity Probes & Stale Health Prevention', () => {
    it('blocks readiness when live connectivity probe fails even if connection status is marked HEALTHY', async () => {
      const proj = await projectService.createProject(workspaceA.id, 'Proj Readiness Probe', undefined, userA.user.id);
      const plan = await planService.createPlan(proj.id, 'Plan Readiness Probe', userA.user.id);
      const mapRes = await db.query(
        `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
         VALUES ($1, $2, 1, '{"objects":[{"source":{"collection":"items","key":"id"},"destination":{"table":"items","key":"id"},"identity":{"sourceKey":"id","destinationKey":"id"},"fields":[{"sourcePath":"id","destinationPath":"id"}]}]}', 'hash_rp', $3) RETURNING id`,
        [workspaceA.id, plan.id, userA.user.id],
      );
      const pv = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: sourceConnA.id,
          destinationConnectionId: destConnA.id,
          mappingVersionId: mapRes.rows[0].id,
          scope: { collections: ['items'] },
        },
        userA.user.id,
      );

      // Configure a failing customProber to simulate a stale HEALTHY status where the database is actually down
      ConnectionService.customProber = async () => ({
        reachable: false,
        errorMessage: 'Network timeout: database host unreachable',
      });

      try {
        const result = await readinessService.checkReadiness(pv.id);
        expect(result.ready).toBe(false);
        expect(result.blockers.some((b) => /connectivity test failed|unreachable/i.test(b))).toBe(true);
      } finally {
        ConnectionService.customProber = undefined;
      }
    });
  });
});
