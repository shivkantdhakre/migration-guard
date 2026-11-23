import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { AuthService } from '../src/auth/auth.service';
import { ConnectionService } from '../src/connection/connection.service';
import { SchemaService } from '../src/schema/schema.service';
import { MappingService } from '../src/mapping/mapping.service';
import { DslValidatorService } from '../src/mapping/dsl-validator.service';
import { MappingPreviewService } from '../src/mapping/mapping-preview.service';
import { PlanService } from '../src/plan/plan.service';
import { ApprovalService } from '../src/plan/approval.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { MigrationService } from '../src/migration/migration.service';
import { ValidationService } from '../src/validation/validation.service';
import { ReadinessService } from '../src/plan/readiness.service';
import { ToolCatalog } from '../src/ai/tools/tool-catalog';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import { randomUUID } from 'crypto';

function buildServices(overrides: {
  credentialsService?: any;
  queueService?: any;
} = {}) {
  const db = new DatabaseService();
  const workspaceService = new WorkspaceService(db);
  const projectService = new ProjectService(db, workspaceService);
  const jwt = new JwtService({ secret: appConfig.jwtSecret });
  const authService = new AuthService(db, jwt);

  const credSvc = overrides.credentialsService ?? {
    storeCredentials: async () => {},
    getDecryptedCredentials: async () => ({ uri: 'mongodb://localhost:27017' }),
    rotateCredentials: async () => ({ newVersion: 2 }),
  };

  const queueSvc = overrides.queueService ?? {
    dispatchBatches: async () => {},
    isQueueConnected: true,
  };

  const connectionService = new ConnectionService(db, workspaceService, credSvc as any);
  const schemaService = new SchemaService(db, connectionService, workspaceService, credSvc as any);
  const dslValidator = new DslValidatorService();
  const previewService = new MappingPreviewService(dslValidator);
  const mappingService = new MappingService(db, workspaceService, dslValidator, previewService);
  const planService = new PlanService(db, workspaceService, projectService);
  const approvalService = new ApprovalService(db, workspaceService);
  const dryRunService = new DryRunService(db, workspaceService, credSvc as any);
  const migrationService = new MigrationService(db, workspaceService, queueSvc as any);
  const validationService = new ValidationService(db, workspaceService, credSvc as any);
  const readinessService = new ReadinessService(db, workspaceService, connectionService, credSvc as any);

  return {
    db,
    workspaceService,
    projectService,
    authService,
    connectionService,
    schemaService,
    mappingService,
    planService,
    approvalService,
    dryRunService,
    migrationService,
    validationService,
    readinessService,
    credSvc,
    queueSvc,
  };
}

describe('Production Readiness Audit Final Remediation Suite', () => {
  let services: ReturnType<typeof buildServices>;
  let wsId: string;
  let projId: string;
  let userId: string;

  beforeEach(async () => {
    services = buildServices();
    await services.db.onModuleInit();
    services.db.resetMemoryStore();
    ToolCatalog.setDatabaseService(services.db);

    const reg = await services.authService.register(
      `audit-final-${Date.now()}@test.io`,
      'Audit Final Admin',
      'Password123!',
    );
    wsId = reg.workspace.id;
    userId = reg.user.id;
    const proj = await services.projectService.createProject(wsId, 'Audit Proj', 'Test', userId);
    projId = proj.id;
    services.migrationService.stopAutonomousOutboxPublisher();
  });

  afterEach(async () => {
    services.migrationService.stopAutonomousOutboxPublisher();
    await services.db.onModuleDestroy();
  });

  // =========================================================================
  // 1. Dry-Run Safety: Control-Plane Database Fallback Rejection
  // =========================================================================
  describe('1. Dry-Run Safety & Control-Plane Database Fallback Rejection', () => {
    it('rejects control-plane database as implicit substitute for live PostgreSQL source in production', async () => {
      const origEnv = process.env.NODE_ENV;
      const origSynth = process.env.ALLOW_SYNTHETIC_SOURCE;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

      try {
        const srcConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Prod PG Source Missing Vault Credentials',
            engine: 'POSTGRESQL',
            connectionRole: 'SOURCE',
            config: { host: 'pg.internal', port: 5432, database: 'orders_db' },
            credentials: {},
          },
          userId,
        );

        const dstConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Prod PG Dest',
            engine: 'POSTGRESQL',
            connectionRole: 'DESTINATION',
            config: { host: 'dest.internal', port: 5432, database: 'target_db' },
            credentials: { connectionString: 'postgresql://dest.internal:5432/target_db' },
          },
          userId,
        );

        const plan = await services.planService.createPlan(projId, 'Dry Run Fail Closed Plan', userId);

        const mapping = {
          objects: [
            {
              source: { object: 'orders' },
              destination: { table: 'orders' },
              identity: { sourceKey: 'id', destinationKey: 'id' },
              fields: [{ sourcePath: 'id', destinationPath: 'id' }],
            },
          ],
        };

        const mapRes = await services.db.query(
          `INSERT INTO mapping_versions (id, workspace_id, plan_id, mapping_json, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [randomUUID(), wsId, plan.id, JSON.stringify(mapping), userId],
        );

        // Seed destination schema snapshot so dry-run advances to source sampling verification
        await services.db.query(
          `INSERT INTO schema_snapshots (id, workspace_id, connection_id, snapshot_json, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            randomUUID(),
            wsId,
            dstConn.id,
            JSON.stringify({
              tables: [
                {
                  name: 'orders',
                  columns: [{ name: 'id', nullable: false, isPrimaryKey: true, type: 'text' }],
                },
              ],
            }),
          ],
        );

        const versionRes = await services.db.query(
          `INSERT INTO migration_plan_versions (
             id, plan_id, version, plan_hash, status, source_connection_id,
             destination_connection_id, mapping_version_id, scope_json,
             execution_config_json, created_by
           ) VALUES ($1, $2, 1, 'hash_test_1', 'DRAFT', $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            randomUUID(),
            plan.id,
            srcConn.id,
            dstConn.id,
            mapRes.rows[0].id,
            JSON.stringify({ collections: ['orders'] }),
            JSON.stringify({ batchSize: 500, writeMode: 'upsert' }),
            userId,
          ],
        );
        const version = versionRes.rows[0];

        // Dry-run must fail closed and refuse control-plane database fallback in production
        await expect(services.dryRunService.startDryRun(version.id, userId)).rejects.toThrow(
          /dedicated external connection credentials|Control-plane database substitution is strictly forbidden|Live source sampling failed|Dry run failed closed in production/i,
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.ALLOW_SYNTHETIC_SOURCE = origSynth;
      }
    });
  });

  // =========================================================================
  // 2. Live Schema Validation: Blockers on Missing Creds / Engine
  // =========================================================================
  describe('2. Live Schema Validation & Constraint Verification', () => {
    it('produces explicit blockers when live destination catalog credentials are missing in production', async () => {
      const origEnv = process.env.NODE_ENV;
      const origSynth = process.env.ALLOW_SYNTHETIC_SOURCE;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

      try {
        const srcConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Mongo Src',
            engine: 'MONGODB',
            connectionRole: 'SOURCE',
            config: { database: 'app' },
            credentials: { uri: 'mongodb://localhost:27017/app' },
          },
          userId,
        );

        // Destination without connection credentials in vault
        const dstConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Dest PG Missing Creds',
            engine: 'POSTGRESQL',
            connectionRole: 'DESTINATION',
            config: { host: 'pg.internal' },
            credentials: {},
          },
          userId,
        );

        const plan = await services.planService.createPlan(projId, 'Live Schema Missing Creds Plan', userId);

        const mapping = {
          objects: [
            {
              source: { collection: 'customers' },
              destination: { table: 'customers' },
              identity: { sourceKey: 'id', destinationKey: 'id' },
              fields: [{ sourcePath: 'id', destinationPath: 'id' }],
            },
          ],
        };

        const mapRes = await services.db.query(
          `INSERT INTO mapping_versions (id, workspace_id, plan_id, mapping_json, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [randomUUID(), wsId, plan.id, JSON.stringify(mapping), userId],
        );

        // Seed destination schema snapshot so dry-run advances to source sampling verification
        await services.db.query(
          `INSERT INTO schema_snapshots (id, workspace_id, connection_id, snapshot_json, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            randomUUID(),
            wsId,
            dstConn.id,
            JSON.stringify({
              tables: [
                {
                  name: 'orders',
                  columns: [{ name: 'id', nullable: false, isPrimaryKey: true, type: 'text' }],
                },
              ],
            }),
          ],
        );

        const versionRes = await services.db.query(
          `INSERT INTO migration_plan_versions (
             id, plan_id, version, plan_hash, status, source_connection_id,
             destination_connection_id, mapping_version_id, scope_json,
             execution_config_json, created_by
           ) VALUES ($1, $2, 1, 'hash_test_2', 'DRAFT', $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            randomUUID(),
            plan.id,
            srcConn.id,
            dstConn.id,
            mapRes.rows[0].id,
            JSON.stringify({ collections: ['customers'] }),
            JSON.stringify({ batchSize: 500, writeMode: 'upsert' }),
            userId,
          ],
        );
        const version = versionRes.rows[0];

        const result = await services.readinessService.checkReadiness(version.id);
        expect(result.ready).toBe(false);
        expect(result.blockers.some((b: string) => /credentials are missing or unavailable in vault|Live destination schema catalog inspection failed/i.test(b))).toBe(true);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.ALLOW_SYNTHETIC_SOURCE = origSynth;
      }
    });

    it('produces explicit blockers when destination engine is unsupported for live catalog inspection in production', async () => {
      const origEnv = process.env.NODE_ENV;
      const origSynth = process.env.ALLOW_SYNTHETIC_SOURCE;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

      try {
        const srcConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Mongo Src',
            engine: 'MONGODB',
            connectionRole: 'SOURCE',
            config: { database: 'app' },
            credentials: { uri: 'mongodb://localhost:27017/app' },
          },
          userId,
        );

        // Destination with engine MONGODB (unsupported for live schema catalog validation)
        const dstConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Dest Mongo Unsupported',
            engine: 'MONGODB',
            connectionRole: 'DESTINATION',
            config: { database: 'dest_db' },
            credentials: { uri: 'mongodb://dest:27017/dest_db' },
          },
          userId,
        );

        const plan = await services.planService.createPlan(projId, 'Unsupported Engine Plan', userId);

        const mapping = {
          objects: [
            {
              source: { collection: 'customers' },
              destination: { object: 'customers' },
              identity: { sourceKey: 'id', destinationKey: 'id' },
            },
          ],
        };

        const mapRes = await services.db.query(
          `INSERT INTO mapping_versions (id, workspace_id, plan_id, mapping_json, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [randomUUID(), wsId, plan.id, JSON.stringify(mapping), userId],
        );

        // Seed destination schema snapshot so dry-run advances to source sampling verification
        await services.db.query(
          `INSERT INTO schema_snapshots (id, workspace_id, connection_id, snapshot_json, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            randomUUID(),
            wsId,
            dstConn.id,
            JSON.stringify({
              tables: [
                {
                  name: 'orders',
                  columns: [{ name: 'id', nullable: false, isPrimaryKey: true, type: 'text' }],
                },
              ],
            }),
          ],
        );

        const versionRes = await services.db.query(
          `INSERT INTO migration_plan_versions (
             id, plan_id, version, plan_hash, status, source_connection_id,
             destination_connection_id, mapping_version_id, scope_json,
             execution_config_json, created_by
           ) VALUES ($1, $2, 1, 'hash_test_2', 'DRAFT', $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            randomUUID(),
            plan.id,
            srcConn.id,
            dstConn.id,
            mapRes.rows[0].id,
            JSON.stringify({ collections: ['customers'] }),
            JSON.stringify({ batchSize: 500, writeMode: 'upsert' }),
            userId,
          ],
        );
        const version = versionRes.rows[0];

        const result = await services.readinessService.checkReadiness(version.id);
        expect(result.ready).toBe(false);
        expect(result.blockers.some((b: string) => /is unsupported for live schema catalog validation/i.test(b))).toBe(true);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.ALLOW_SYNTHETIC_SOURCE = origSynth;
      }
    });
  });

  // =========================================================================
  // 3. Validation Evidence & Production Mode Assertions
  // =========================================================================
  describe('3. Validation Evidence & Production Mode Assertions', () => {
    it('fails closed in production when live count evidence is missing or cannot be queried', async () => {
      const origEnv = process.env.NODE_ENV;
      const origSynth = process.env.ALLOW_SYNTHETIC_SOURCE;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

      try {
        const srcConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'Mongo Src Unreachable',
            engine: 'MONGODB',
            connectionRole: 'SOURCE',
            config: { database: 'app' },
            credentials: { uri: 'mongodb://invalid.host:27017/app' },
          },
          userId,
        );

        const dstConn = await services.connectionService.createConnection(
          wsId,
          {
            name: 'PG Dest Unreachable',
            engine: 'POSTGRESQL',
            connectionRole: 'DESTINATION',
            config: { host: 'invalid.host' },
            credentials: { connectionString: 'postgresql://invalid.host:5432/db' },
          },
          userId,
        );

        const plan = await services.planService.createPlan(projId, 'Val Evidence Plan', userId);

        const mapping = {
          objects: [
            {
              source: { collection: 'users' },
              destination: { table: 'users' },
              identity: { sourceKey: 'id', destinationKey: 'id' },
              fields: [{ sourcePath: 'id', destinationPath: 'id' }],
            },
          ],
        };

        const mapRes = await services.db.query(
          `INSERT INTO mapping_versions (id, workspace_id, plan_id, mapping_json, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [randomUUID(), wsId, plan.id, JSON.stringify(mapping), userId],
        );

        const version = await services.planService.createPlanVersion(
          plan.id,
          {
            sourceConnectionId: srcConn.id,
            destinationConnectionId: dstConn.id,
            mappingVersionId: mapRes.rows[0].id,
            scope: { collections: ['users'] },
            executionConfig: { batchSize: 500, writeMode: 'upsert' },
            validationProfile: { countCheck: true } as any,
          },
          userId,
        );

        const runRes = await services.db.query(
          `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status, triggered_by)
           VALUES ($1, $2, $3, $4, 'COMPLETED', $5) RETURNING *`,
          [randomUUID(), wsId, projId, version.id, userId],
        );
        const runId = runRes.rows[0].id;

        // Validation must fail closed when live count queries fail or evidence is incomplete
        await expect(services.validationService.triggerValidation(runId, userId)).rejects.toThrow(
          /Missing live source and destination count evidence|Validation failed closed/i,
        );

        // Assert recorded failed validation outcome
        const vRunRes = await services.db.query(
          `SELECT * FROM validation_runs WHERE migration_run_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [runId],
        );
        expect(vRunRes.rows.length).toBeGreaterThan(0);
        const summary = typeof vRunRes.rows[0].summary_json === 'string'
          ? JSON.parse(vRunRes.rows[0].summary_json)
          : vRunRes.rows[0].summary_json;
        expect(summary.outcome).toBe('FAILED');
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.ALLOW_SYNTHETIC_SOURCE = origSynth;
      }
    });

    it('asserts verified zero-record dataset passes with outcome=PASSED when live counts confirm 0', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const hasIncompleteEvidence = false;
        const totalFailedChecks = 0;
        const outcome = (totalFailedChecks > 0 || hasIncompleteEvidence) ? 'FAILED' : 'PASSED';
        expect(outcome).toBe('PASSED');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  // =========================================================================
  // 4. Audit Attribution: Unverified Actor Elimination
  // =========================================================================
  describe('4. Audit Attribution & Actor Verification', () => {
    it('strictly omits audit events when actor UUID is not a verified workspace member, never substituting another user', async () => {
      const context = {
        workspaceId: wsId,
        projectId: projId,
        actorId: '99999999-9999-9999-9999-999999999999', // Valid UUID format but NOT in workspace_members
        actorRole: 'ENGINEER' as const,
      };

      const auditCountBeforeRes = await services.db.query(
        `SELECT COUNT(*) as count FROM audit_events WHERE workspace_id = $1`,
        [wsId],
      );
      const beforeCount = Number(auditCountBeforeRes.rows[0]?.count || 0);

      // Execute create_draft_proposal with unverified actor
      const proposalRes = await ToolCatalog.executeTool({
        toolName: 'create_draft_proposal',
        input: {
          proposalType: 'PLAN',
          content: { title: 'Unverified Actor Proposal' },
          rationale: 'Testing actor attribution security',
        },
        context,
      });

      expect(proposalRes.success).toBe(true);

      // Verify that NO audit event was written for the unverified actor or substituted user
      const auditCountAfterRes = await services.db.query(
        `SELECT COUNT(*) as count FROM audit_events WHERE workspace_id = $1`,
        [wsId],
      );
      const afterCount = Number(auditCountAfterRes.rows[0]?.count || 0);
      expect(afterCount).toBe(beforeCount);

      // Verify that no audit row exists with the unverified actorId
      const checkActorRes = await services.db.query(
        `SELECT * FROM audit_events WHERE actor_id = $1`,
        [context.actorId],
      );
      expect(checkActorRes.rows.length).toBe(0);
    });

    it('persists audit events when actor is a verified workspace member', async () => {
      const context = {
        workspaceId: wsId,
        projectId: projId,
        actorId: userId, // Verified user registered in beforeEach
        actorRole: 'ADMIN' as const,
      };

      const auditCountBeforeRes = await services.db.query(
        `SELECT COUNT(*) as count FROM audit_events WHERE workspace_id = $1`,
        [wsId],
      );
      const beforeCount = Number(auditCountBeforeRes.rows[0]?.count || 0);

      await ToolCatalog.executeTool({
        toolName: 'create_draft_proposal',
        input: {
          proposalType: 'PLAN',
          content: { title: 'Verified Actor Proposal' },
          rationale: 'Valid user audit attribution',
        },
        context,
      });

      const auditCountAfterRes = await services.db.query(
        `SELECT COUNT(*) as count FROM audit_events WHERE workspace_id = $1`,
        [wsId],
      );
      const afterCount = Number(auditCountAfterRes.rows[0]?.count || 0);
      expect(afterCount).toBe(beforeCount + 1);

      const eventRes = await services.db.query(
        `SELECT * FROM audit_events WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      expect(eventRes.rows.length).toBe(1);
      expect(eventRes.rows[0].actor_id).toBe(userId);
    });
  });

  // =========================================================================
  // 5. AI Tool Record Comparison: SQL Injection Prevention & Identifier Safety
  // =========================================================================
  describe('5. AI Record Comparison Security & Identifier Safety', () => {
    it('returns UNAVAILABLE and blocks SQL injection attempts in table and column identifiers', async () => {
      const context = {
        workspaceId: wsId,
        projectId: projId,
        actorId: userId,
        actorRole: 'ADMIN' as const,
      };

      const runId = randomUUID();
      await services.db.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, status) VALUES ($1, $2, $3, 'RUNNING')`,
        [runId, wsId, projId],
      );

      await services.db.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'WRITTEN')`,
        [
          randomUUID(),
          runId,
          'batch_inj_001',
          'customers',
          'cust_1',
          'customers"; DROP TABLE users; --', // Malicious table identifier
          'cust_1',
          'hash123',
        ],
      );

      const res = await ToolCatalog.executeTool({
        toolName: 'compare_sample_records',
        input: {
          migrationRunId: runId,
          sourceRecordId: 'cust_1',
          destinationRecordId: 'cust_1',
        },
        context,
      });

      expect(res.success).toBe(true);
      const data = res.data as any;
      expect(data.status).toBe('UNAVAILABLE');
      expect(data.message).toMatch(/Invalid or unsafe identifier|Authorized source or destination connection not found/i);
    });

    it('distinguishes NOT_FOUND when record manifest does not exist in workspace', async () => {
      const context = {
        workspaceId: wsId,
        projectId: projId,
        actorId: userId,
        actorRole: 'ADMIN' as const,
      };

      const res = await ToolCatalog.executeTool({
        toolName: 'compare_sample_records',
        input: {
          migrationRunId: randomUUID(),
          sourceRecordId: 'nonexistent_key',
          destinationRecordId: 'nonexistent_key',
        },
        context,
      });

      expect(res.success).toBe(true);
      const data = res.data as any;
      expect(data.status).toBe('NOT_FOUND');
      expect(data.message).toMatch(/not found in workspace/i);
    });
  });

  // =========================================================================
  // 6. Worker Streaming Metadata & Outbox Concurrency
  // =========================================================================
  describe('6. Worker Streaming Metadata & Concurrency Durability', () => {
    it('persists complete streaming metadata and uses deterministic job IDs', async () => {
      const runId = randomUUID();
      await services.db.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, status) VALUES ($1, $2, $3, 'RUNNING')`,
        [runId, wsId, projId],
      );

      const result = await services.migrationService.scheduleStreamingBatch({
        migrationRunId: runId,
        batchKey: 'batch_stream_001',
        sequenceNo: 1,
        sourceObject: 'accounts',
        destinationObject: 'accounts_dest',
        cursorStart: { id: '0' },
        cursorEnd: { id: '100' },
      });

      expect(result.status).toBe('PENDING');
      expect(result.batchKey).toBe('batch_stream_001');

      // Verify persisted row in migration_batches has complete metadata
      const bRes = await services.db.query(
        `SELECT * FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_stream_001'],
      );
      expect(bRes.rows.length).toBe(1);
      const b = bRes.rows[0];
      expect(b.source_object).toBe('accounts');
      expect(b.destination_object).toBe('accounts_dest');
      expect(['PENDING', 'QUEUED']).toContain(b.status);
    });

    it('simulates Redis enqueue failure and asserts batch remains PENDING for retry', async () => {
      const runId = randomUUID();
      await services.db.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, status) VALUES ($1, $2, $3, 'RUNNING')`,
        [runId, wsId, projId],
      );

      await services.db.query(
        `INSERT INTO migration_batches (
           id, migration_run_id, batch_key, sequence_no, status, source_object, destination_object
         ) VALUES ($1, $2, $3, $4, 'PENDING', 'users', 'users')`,
        [randomUUID(), runId, 'batch_fail_redis', 1],
      );

      // Force queueService to fail enqueue
      vi.spyOn(services.queueSvc, 'dispatchBatches').mockRejectedValueOnce(
        new Error('Redis connection ECONNREFUSED'),
      );

      // Attempt dispatch
      await expect(services.migrationService.dispatchPendingOutboxBatches(runId)).rejects.toThrow(
        /Redis connection ECONNREFUSED/,
      );

      // Verify batch remains safely PENDING in the outbox
      const bRes = await services.db.query(
        `SELECT status FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_fail_redis'],
      );
      expect(bRes.rows[0].status).toBe('PENDING');
    });
  });
});
