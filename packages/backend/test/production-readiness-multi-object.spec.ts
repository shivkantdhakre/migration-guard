import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { AuthService } from '../src/auth/auth.service';
import { ConnectionService } from '../src/connection/connection.service';
import { SchemaService } from '../src/schema/schema.service';
import { MappingService } from '../src/mapping/mapping.service';
import { PlanService } from '../src/plan/plan.service';
import { ApprovalService } from '../src/plan/approval.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { MigrationService } from '../src/migration/migration.service';
import { ValidationService } from '../src/validation/validation.service';
import { ReadinessService } from '../src/plan/readiness.service';
import { DslValidatorService } from '../src/mapping/dsl-validator.service';
import { MappingPreviewService } from '../src/mapping/mapping-preview.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

describe('Production Readiness & Multi-Object Migration Assurance Suite', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let authService: AuthService;
  let connectionService: ConnectionService;
  let schemaService: SchemaService;
  let mappingService: MappingService;
  let planService: PlanService;
  let approvalService: ApprovalService;
  let dryRunService: DryRunService;
  let migrationService: MigrationService;
  let validationService: ValidationService;
  let readinessService: ReadinessService;
  let jwt: JwtService;

  let dispatchedPayloads: any[] = [];
  const mockQueueService = {
    dispatchBatches: async (payloads: any[]) => {
      dispatchedPayloads.push(...payloads);
    },
    dispatchJob: async (payload: any) => {
      dispatchedPayloads.push(payload);
    },
  };

  const mockCredentialsService = {
    storeCredentials: async () => {},
    getDecryptedCredentials: async () => ({
      uri: 'mongodb://localhost:27017',
      connectionString: 'postgresql://postgres:postgres@localhost:5432/migrationguard_dest',
    }),
    rotateCredentials: async () => ({ newVersion: 2 }),
  } as any;

  beforeEach(async () => {
    dispatchedPayloads = [];
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    connectionService = new ConnectionService(db, workspaceService, mockCredentialsService);
    schemaService = new SchemaService(db, connectionService, workspaceService, mockCredentialsService);

    const dslValidator = new DslValidatorService();
    const previewService = new MappingPreviewService(dslValidator);
    mappingService = new MappingService(db, workspaceService, dslValidator, previewService);

    planService = new PlanService(db, workspaceService, projectService);
    approvalService = new ApprovalService(db, workspaceService);
    dryRunService = new DryRunService(db, workspaceService, mockCredentialsService);
    migrationService = new MigrationService(db, workspaceService, mockQueueService as any);
    validationService = new ValidationService(db, workspaceService, mockCredentialsService);
    readinessService = new ReadinessService(db, workspaceService, connectionService);

    ConnectionService.customProber = async (conn) => ({
      reachable: true,
      engineVersion: conn.engine === 'MONGODB' ? 'MongoDB 7.0' : 'PostgreSQL 16',
    });
  });

  afterEach(() => {
    ConnectionService.customProber = undefined;
    migrationService.stopAutonomousOutboxPublisher();
  });

  it('1. Persists complete immutable batch metadata across multi-object migration runs', async () => {
    const reg = await authService.register('eng1@multi.io', 'Engineer 1', 'Password123!');
    const wsId = reg.workspace.id;
    const proj = await projectService.createProject(wsId, 'Multi-Object Migration', 'Tests multiple collections', reg.user.id);

    const srcConn = await connectionService.createConnection(
      wsId,
      { name: 'Mongo Prod', engine: 'MONGODB', connectionRole: 'SOURCE', config: { database: 'appdb' }, credentials: { uri: 'mongodb://localhost:27017' } },
      reg.user.id,
    );
    const dstConn = await connectionService.createConnection(
      wsId,
      { name: 'PG Prod', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: { database: 'pgdb' }, credentials: { connectionString: 'postgresql://localhost:5432' } },
      reg.user.id,
    );

    const plan = await planService.createPlan(proj.id, 'Multi Plan', reg.user.id);

    // Multi-object mapping version: customers AND orders
    const multiMappingDsl = {
      version: '1.0.0',
      objects: [
        {
          source: { collection: 'customers', key: '_id' },
          destination: { table: 'customers', key: 'id' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PASSTHROUGH' },
          fields: [{ sourcePath: 'name', destinationPath: 'name' }],
        },
        {
          source: { collection: 'orders', key: '_id' },
          destination: { table: 'orders', key: 'id' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PASSTHROUGH' },
          fields: [{ sourcePath: 'amount', destinationPath: 'amount' }],
        },
      ],
    };

    const mapVersion = await mappingService.createVersion(plan.id, multiMappingDsl, reg.user.id);

    const planVersion = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: srcConn.id,
        destinationConnectionId: dstConn.id,
        mappingVersionId: mapVersion.id,
        scope: {
          tables: [
            { source: 'customers', destination: 'customers' },
            { source: 'orders', destination: 'orders' },
          ],
        },
        executionConfig: { batchSize: 500, writeMode: 'upsert' },
      },
      reg.user.id,
    );

    // Approve plan version before running
    await approvalService.submitApproval(
      planVersion.id,
      { decision: 'APPROVE', planHash: planVersion.plan_hash, comment: 'Approved for multi-object migration' },
      reg.user.id,
    );

    // Start migration run
    const runResult = await migrationService.startMigrationRun(planVersion.id, reg.user.id);
    expect(runResult.runId).toBeDefined();

    // Verify database rows in migration_batches: both customers and orders are persisted!
    const batches = await db.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 ORDER BY sequence_no ASC`,
      [runResult.runId],
    );

    expect(batches.rows.length).toBe(2);

    const custBatch = batches.rows[0];
    expect(custBatch.source_object).toBe('customers');
    expect(custBatch.destination_object).toBe('customers');
    expect(custBatch.status).toBe('QUEUED');
    expect(custBatch.mapping_version_id).toBe(mapVersion.id);

    const orderBatch = batches.rows[1];
    expect(orderBatch.source_object).toBe('orders');
    expect(orderBatch.destination_object).toBe('orders');
    expect(orderBatch.status).toBe('QUEUED');
    expect(orderBatch.mapping_version_id).toBe(mapVersion.id);

    // Verify dispatched BullMQ payloads did not lose table info or default to customers
    expect(dispatchedPayloads.length).toBe(2);
    expect(dispatchedPayloads[0].sourceObject).toBe('customers');
    expect(dispatchedPayloads[0].destinationObject).toBe('customers');
    expect(dispatchedPayloads[1].sourceObject).toBe('orders');
    expect(dispatchedPayloads[1].destinationObject).toBe('orders');
  });

  it('2. Autonomous outbox publisher recovers and dispatches pending batches after crash/restart', async () => {
    const reg = await authService.register('outbox@multi.io', 'Outbox Eng', 'Password123!');
    const wsId = reg.workspace.id;
    const proj = await projectService.createProject(wsId, 'Crash Project', 'Testing outbox crash recovery', reg.user.id);

    const plan = await planService.createPlan(proj.id, 'Outbox Plan', reg.user.id);
    const srcConn = await connectionService.createConnection(wsId, { name: 'Src', engine: 'MONGODB', connectionRole: 'SOURCE', config: {}, credentials: {} }, reg.user.id);
    const dstConn = await connectionService.createConnection(wsId, { name: 'Dst', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: {}, credentials: {} }, reg.user.id);

    const planVersion = await planService.createPlanVersion(
      plan.id,
      { sourceConnectionId: srcConn.id, destinationConnectionId: dstConn.id },
      reg.user.id,
    );

    const runRes = await db.query(
      `INSERT INTO migration_runs (workspace_id, project_id, plan_version_id, status)
       VALUES ($1, $2, $3, 'RUNNING') RETURNING *`,
      [wsId, proj.id, planVersion.id],
    );
    const runId = runRes.rows[0].id;

    // Simulate an API crash right after inserting pending batches into DB before dispatch
    await db.query(
      `INSERT INTO migration_batches (
         migration_run_id, batch_key, sequence_no, status,
         source_object, destination_object
       ) VALUES ($1, 'batch_crash_01', 1, 'PENDING', 'audit_logs', 'audit_logs')`,
      [runId],
    );

    // Clear queue buffer
    dispatchedPayloads = [];

    // Trigger autonomous publisher (as happens on API startup / background loop)
    const publishedCount = await migrationService.dispatchPendingOutboxBatches();
    expect(publishedCount).toBe(1);

    // Verify batch in DB is now marked QUEUED
    const checkBatch = await db.query(
      `SELECT status, source_object, destination_object FROM migration_batches WHERE migration_run_id = $1 AND batch_key = 'batch_crash_01'`,
      [runId],
    );
    expect(checkBatch.rows[0].status).toBe('QUEUED');
    expect(checkBatch.rows[0].source_object).toBe('audit_logs');
    expect(checkBatch.rows[0].destination_object).toBe('audit_logs');

    // Verify BullMQ job payload received the exact persisted context
    expect(dispatchedPayloads.length).toBe(1);
    expect(dispatchedPayloads[0].batchKey).toBe('batch_crash_01');
    expect(dispatchedPayloads[0].sourceObject).toBe('audit_logs');
    expect(dispatchedPayloads[0].destinationObject).toBe('audit_logs');
  });

  it('3. Multi-object validation detects data discrepancies, flags tamper, and distinguishes execution from outcome', async () => {
    const reg = await authService.register('val@multi.io', 'Validation Eng', 'Password123!');
    const wsId = reg.workspace.id;
    const proj = await projectService.createProject(wsId, 'Val Project', 'Testing multi-object validation', reg.user.id);

    const plan = await planService.createPlan(proj.id, 'Val Plan', reg.user.id);
    const srcConn = await connectionService.createConnection(wsId, { name: 'Src', engine: 'MONGODB', connectionRole: 'SOURCE', config: {}, credentials: {} }, reg.user.id);
    const dstConn = await connectionService.createConnection(wsId, { name: 'Dst', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: {}, credentials: {} }, reg.user.id);

    const multiMappingDsl = {
      version: '1.0.0',
      objects: [
        {
          source: { collection: 'customers', key: '_id' },
          destination: { table: 'customers', key: 'id' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PASSTHROUGH' },
          fields: [{ sourcePath: 'name', destinationPath: 'name' }],
        },
        {
          source: { collection: 'orders', key: '_id' },
          destination: { table: 'orders', key: 'id' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PASSTHROUGH' },
          fields: [{ sourcePath: 'amount', destinationPath: 'amount' }],
        },
      ],
    };

    const mapVersion = await mappingService.createVersion(plan.id, multiMappingDsl, reg.user.id);
    const planVersion = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: srcConn.id,
        destinationConnectionId: dstConn.id,
        mappingVersionId: mapVersion.id,
      },
      reg.user.id,
    );

    const runRes = await db.query(
      `INSERT INTO migration_runs (workspace_id, project_id, plan_version_id, status)
       VALUES ($1, $2, $3, 'COMPLETED') RETURNING *`,
      [wsId, proj.id, planVersion.id],
    );
    const runId = runRes.rows[0].id;

    const bRes = await db.query(
      `INSERT INTO migration_batches (migration_run_id, batch_key, sequence_no, status, source_object, destination_object)
       VALUES ($1, 'b1', 1, 'COMMITTED', 'customers', 'customers') RETURNING *`,
      [runId],
    );
    const batchId = bRes.rows[0].id;

    // Seed manifests for customers AND orders
    await db.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key,
         source_object, source_key, destination_object, destination_key,
         status
       ) VALUES
       (gen_random_uuid(), $1, $2, 'b1', 'customers', 'c1', 'customers', 'c1', 'WRITTEN'),
       (gen_random_uuid(), $1, $2, 'b1', 'orders', 'o1', 'orders', 'o1', 'WRITTEN')`,
      [runId, batchId],
    );

    // Seed real source and destination tables
    await db.query(`CREATE TABLE IF NOT EXISTS source_customers (id TEXT PRIMARY KEY, name TEXT)`);
    await db.query(`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT)`);
    await db.query(`CREATE TABLE IF NOT EXISTS source_orders (id TEXT PRIMARY KEY, amount NUMERIC)`);
    await db.query(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, amount NUMERIC)`);

    // Customer records match
    await db.query(`INSERT INTO source_customers (id, name) VALUES ('c1', 'Alice')`);
    await db.query(`INSERT INTO customers (id, name) VALUES ('c1', 'Alice')`);

    // Order record is deliberately tampered with in destination (100.00 vs 999.99)
    await db.query(`INSERT INTO source_orders (id, amount) VALUES ('o1', 100.00)`);
    await db.query(`INSERT INTO orders (id, amount) VALUES ('o1', 999.99)`);

    const valRun = await validationService.triggerValidation(runId, reg.user.id);

    // Execution finished successfully, but verification outcome is FAILED!
    expect(valRun.status).toBe('COMPLETED');
    expect(valRun.summary_json.executionStatus).toBe('COMPLETED');
    expect(valRun.summary_json.outcome).toBe('FAILED');
    expect(valRun.summary_json.failedChecks).toBeGreaterThan(0);
    expect(valRun.summary_json.objectsValidated).toContain('customers -> customers');
    expect(valRun.summary_json.objectsValidated).toContain('orders -> orders');

    // Verify discrepancy recorded in database
    const discRes = await db.query(
      `SELECT * FROM discrepancies WHERE validation_run_id = $1`,
      [valRun.id],
    );
    expect(discRes.rows.length).toBeGreaterThan(0);
  });

  it('4. Dry run fails closed in production and blocks approval when destination schema conflicts exist', async () => {
    const reg = await authService.register('dryrun@multi.io', 'DryRun Eng', 'Password123!');
    const wsId = reg.workspace.id;
    const proj = await projectService.createProject(wsId, 'DryRun Project', 'Testing dry run integrity', reg.user.id);

    const plan = await planService.createPlan(proj.id, 'Dry Plan', reg.user.id);
    const srcConn = await connectionService.createConnection(wsId, { name: 'Src', engine: 'MONGODB', connectionRole: 'SOURCE', config: {}, credentials: {} }, reg.user.id);
    const dstConn = await connectionService.createConnection(wsId, { name: 'Dst', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: {}, credentials: {} }, reg.user.id);

    // Destination schema snapshot with non-nullable required column 'must_exist_col'
    const dstSnap = await db.query(
      `INSERT INTO schema_snapshots (workspace_id, connection_id, snapshot_json)
       VALUES ($1, $2, $3) RETURNING *`,
      [
        wsId,
        dstConn.id,
        {
          tables: [
            {
              name: 'customers',
              columns: [
                { name: 'id', nullable: false, isPrimaryKey: true },
                { name: 'must_exist_col', nullable: false, isPrimaryKey: false },
              ],
            },
          ],
        },
      ],
    );

    const planVersion = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: srcConn.id,
        destinationConnectionId: dstConn.id,
        destinationSchemaSnapshotId: dstSnap.rows[0].id,
      },
      reg.user.id,
    );

    // Non-production test: missing non-nullable column marks readyForApproval = false
    const dryRunResult = await dryRunService.startDryRun(planVersion.id);
    expect(dryRunResult.status).toBe('FAILED');
    expect(dryRunResult.readyForApproval).toBe(false);
    expect(dryRunResult.potentialTypeConflicts.length).toBeGreaterThan(0);

    // Production test: strict fail-closed when source sample is unavailable
    const origAllow = process.env.ALLOW_SYNTHETIC_SOURCE;
    try {
      process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

      await expect(dryRunService.startDryRun(planVersion.id)).rejects.toThrow(BadRequestException);
    } finally {
      process.env.ALLOW_SYNTHETIC_SOURCE = origAllow;
    }
  });

  it('5. Enforces dry run workspace authorization and rejects unauthorized cross-tenant requests (IDOR Protection)', async () => {
    const regA = await authService.register('tenantA@multi.io', 'Tenant A', 'Password123!');
    const regB = await authService.register('tenantB@multi.io', 'Tenant B', 'Password123!');

    const projA = await projectService.createProject(regA.workspace.id, 'Tenant A Proj', 'Secret', regA.user.id);
    const planA = await planService.createPlan(projA.id, 'Plan A', regA.user.id);
    const srcConn = await connectionService.createConnection(regA.workspace.id, { name: 'Src', engine: 'MONGODB', connectionRole: 'SOURCE', config: {}, credentials: {} }, regA.user.id);
    const dstConn = await connectionService.createConnection(regA.workspace.id, { name: 'Dst', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: {}, credentials: {} }, regA.user.id);

    const planVersionA = await planService.createPlanVersion(
      planA.id,
      { sourceConnectionId: srcConn.id, destinationConnectionId: dstConn.id },
      regA.user.id,
    );

    const dryRunA = await dryRunService.startDryRun(planVersionA.id);

    // User A can access own dry run
    const resultA = await dryRunService.getDryRun(dryRunA.id, regA.user.id);
    expect(resultA.id).toBe(dryRunA.id);

    // User B is rejected with ForbiddenException (IDOR Protection)
    await expect(dryRunService.getDryRun(dryRunA.id, regB.user.id)).rejects.toThrow(ForbiddenException);
  });
});
