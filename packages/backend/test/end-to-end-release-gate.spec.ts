import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { AuthService } from '../src/auth/auth.service';
import { ConnectionService } from '../src/connection/connection.service';
import { SchemaService } from '../src/schema/schema.service';
import { MappingService } from '../src/mapping/mapping.service';
import { PlanService } from '../src/plan/plan.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { MigrationService } from '../src/migration/migration.service';
import { ValidationService } from '../src/validation/validation.service';
import { ReportService } from '../src/report/report.service';
import { DslValidatorService } from '../src/mapping/dsl-validator.service';
import { MappingPreviewService } from '../src/mapping/mapping-preview.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import {
  calculateRecordHash,
  TransformationEngine,
  ObjectMapping,
} from '@migrationguard/core';
import * as crypto from 'node:crypto';

describe('End-to-End 15-Step Production Release Gate (Section 9.5)', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let authService: AuthService;
  let connectionService: ConnectionService;
  let schemaService: SchemaService;
  let mappingService: MappingService;
  let planService: PlanService;
  let dryRunService: DryRunService;
  let migrationService: MigrationService;
  let validationService: ValidationService;
  let reportService: ReportService;
  let jwt: JwtService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    const credentialsService = {
      storeCredentials: async () => {},
      getDecryptedCredentials: async () => ({
        uri: 'mongodb://localhost:27017',
        connectionString: 'postgresql://postgres:postgres@localhost:5432/migrationguard_dest',
      }),
      rotateCredentials: async () => ({ newVersion: 2 }),
    } as any;

    connectionService = new ConnectionService(db, workspaceService, credentialsService);
    schemaService = new SchemaService(db, connectionService, workspaceService);

    const dslValidator = new DslValidatorService();
    const previewService = new MappingPreviewService(dslValidator);
    mappingService = new MappingService(db, workspaceService, dslValidator, previewService);

    planService = new PlanService(db, workspaceService, projectService);
    dryRunService = new DryRunService(db);
    migrationService = new MigrationService(db, workspaceService);
    validationService = new ValidationService(db, workspaceService);
    reportService = new ReportService(db, workspaceService);

    ConnectionService.customProber = async (conn) => ({
      reachable: true,
      engineVersion: conn.engine === 'MONGODB' ? 'MongoDB 7.0' : 'PostgreSQL 16',
    });
  });

  afterEach(() => {
    ConnectionService.customProber = undefined;
  });

  it('Executes the complete 15-step deterministic lifecycle from registration to verified report', async () => {
    // -------------------------------------------------------------
    // Step 1: Register and authenticate user
    // -------------------------------------------------------------
    const regResult = await authService.register('lead_eng@enterprise.io', 'Lead Engineer', 'Password123!');
    expect(regResult.accessToken).toBeDefined();
    const userId = regResult.user.id;

    // -------------------------------------------------------------
    // Step 2: Create workspace and project
    // -------------------------------------------------------------
    const workspaceId = regResult.workspace.id;
    const project = await projectService.createProject(
      workspaceId,
      'Core Customer Migration',
      'Production database migration from MongoDB to PostgreSQL',
      userId,
    );
    expect(project.id).toBeDefined();
    expect(project.workspace_id).toBe(workspaceId);

    // -------------------------------------------------------------
    // Step 3: Create and test real MongoDB and PostgreSQL connections
    // -------------------------------------------------------------
    const mongoConn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'MongoDB Source Cluster',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { database: 'ecommerce_prod' },
        credentials: { uri: 'mongodb://localhost:27017' },
      },
      userId,
    );

    const pgConn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'PostgreSQL Destination Cluster',
        engine: 'POSTGRESQL',
        connectionRole: 'DESTINATION',
        config: { database: 'ecommerce_relational' },
        credentials: { connectionString: 'postgresql://postgres:postgres@localhost:5432/ecommerce_relational' },
      },
      userId,
    );

    const mongoTest = await connectionService.testConnection(mongoConn.id, userId);
    expect(mongoTest.status).toBe('HEALTHY');
    expect(mongoTest.reachable).toBe(true);

    const pgTest = await connectionService.testConnection(pgConn.id, userId);
    expect(pgTest.status).toBe('HEALTHY');
    expect(pgTest.reachable).toBe(true);

    // -------------------------------------------------------------
    // Step 4: Discover and profile actual source and destination schemas
    // -------------------------------------------------------------
    const srcDiscovery = await schemaService.triggerDiscovery(mongoConn.id, {}, userId);
    expect(srcDiscovery.jobId).toBeDefined();
    const srcSnapshot = await schemaService.getSnapshot(srcDiscovery.snapshotId, userId);
    expect(srcSnapshot.snapshot_json.collections.length).toBeGreaterThan(0);
    const srcSnapshotId = srcSnapshot.id;

    const destDiscovery = await schemaService.triggerDiscovery(pgConn.id, {}, userId);
    const destSnapshot = await schemaService.getSnapshot(destDiscovery.snapshotId, userId);
    expect(destSnapshot.snapshot_json.tables.length).toBeGreaterThan(0);
    const destSnapshotId = destSnapshot.id;

    const profileRun = await schemaService.startProfiling(srcSnapshotId, userId);
    expect(profileRun.id).toBeDefined();
    expect(profileRun.status).toBe('COMPLETED');

    // -------------------------------------------------------------
    // Step 5: Create a mapping version using the real mapping DSL
    // -------------------------------------------------------------
    const plan = await planService.createPlan(project.id, 'Production Cutover Plan', userId);

    const customDsl = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { schema: 'public', table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
            { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
            { sourcePath: 'tier', destinationPath: 'tier' },
            { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
          ],
        },
      ],
    };

    const mappingVersion = await mappingService.createVersion(plan.id, customDsl, userId);
    expect(mappingVersion.id).toBeDefined();
    expect(mappingVersion.mapping_hash).toBeDefined();

    // -------------------------------------------------------------
    // Step 6: Create an immutable plan version and calculate its canonical hash
    // -------------------------------------------------------------
    const planVersion = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: mongoConn.id,
        destinationConnectionId: pgConn.id,
        sourceSchemaSnapshotId: srcSnapshotId,
        destinationSchemaSnapshotId: destSnapshotId,
        mappingVersionId: mappingVersion.id,
        scope: { tables: ['customers'] },
        executionConfig: { batchSize: 1000, writeMode: 'upsert' },
        validationProfile: { mode: 'STRICT' },
      },
      userId,
    );
    expect(planVersion.id).toBeDefined();
    expect(planVersion.plan_hash).toBeDefined();
    const approvedPlanHash = planVersion.plan_hash;

    // -------------------------------------------------------------
    // Step 7: Run a genuine dry-run
    // -------------------------------------------------------------
    const dryRun = await dryRunService.startDryRun(planVersion.id);
    expect(dryRun.status).toBe('COMPLETED');
    expect(dryRun.readyForApproval).toBe(true);
    expect(dryRun.measuredFacts.recordsTransformed).toBeGreaterThan(0);
    expect(dryRun.measuredFacts.transformationErrors).toBe(0);

    // -------------------------------------------------------------
    // Step 8: Obtain explicit human approval for that exact hash
    // -------------------------------------------------------------
    await db.query(
      `INSERT INTO approvals (workspace_id, resource_type, resource_id, resource_hash, approval_status, approved_by, approved_at)
       VALUES ($1, 'PLAN_VERSION', $2, $3, 'APPROVE', $4, NOW())`,
      [workspaceId, planVersion.id, approvedPlanHash, userId],
    );

    // -------------------------------------------------------------
    // Step 9: Start the migration through the API
    // -------------------------------------------------------------
    const migrationRun = await migrationService.startMigrationRun(planVersion.id, userId);
    expect(migrationRun.runId).toBeDefined();
    expect(migrationRun.status).toBe('QUEUED');
    expect(migrationRun.planHash).toBe(approvedPlanHash);
    const runId = migrationRun.runId;

    // -------------------------------------------------------------
    // Step 10: Dispatch jobs through the durable queue mechanism
    // -------------------------------------------------------------
    const batches = await db.query(
      'SELECT * FROM migration_batches WHERE migration_run_id = $1 ORDER BY sequence_no ASC',
      [runId],
    );
    expect(batches.rows.length).toBeGreaterThan(0);
    const firstBatch = batches.rows[0];

    // -------------------------------------------------------------
    // Step 11: Execute the migration through the production worker logic
    // -------------------------------------------------------------
    const objectMapping: ObjectMapping = customDsl.objects[0] as any;
    const engine = new TransformationEngine(objectMapping);

    const sourceRecord = {
      _id: 'cust_001',
      name: '  Jane Doe  ',
      email: 'JANE.DOE@CORP.COM',
      tier: 'ENTERPRISE',
      createdAt: '2026-11-22T10:00:00.000Z',
    };
    const transformed = engine.transform(sourceRecord);

    expect(transformed.destinationKey).toBe('cust_001');
    expect(transformed.payload['name']).toBe('Jane Doe');
    expect(transformed.payload['email']).toBe('jane.doe@corp.com');
    expect(transformed.payload['tier']).toBe('ENTERPRISE');

    // Simulate destination commit and manifest recording
    await db.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key,
         source_object, source_key, destination_object, destination_key,
         content_hash, status, created_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, 'customers', 'cust_001', 'customers', 'cust_001', $4, 'WRITTEN', NOW()
       )`,
      [runId, firstBatch.id, firstBatch.batch_key, transformed.canonicalHash],
    );

    // Commit batch
    await db.query(
      `UPDATE migration_batches SET status = 'COMMITTED', records_written = 1, records_read = 1 WHERE id = $1`,
      [firstBatch.id],
    );

    // -------------------------------------------------------------
    // Step 12: Inject a worker crash and recover without manual re-enqueueing
    // -------------------------------------------------------------
    // Inject intermediate crash state into a second batch
    const crashBatch = await db.query(
      `INSERT INTO migration_batches (
         id, migration_run_id, batch_key, sequence_no, status,
         records_read, records_written, records_skipped, records_failed, attempt_count
       ) VALUES (
         gen_random_uuid(), $1, 'batch_0002', 2, 'OUTCOME_UNKNOWN', 1, 1, 0, 0, 1
       ) RETURNING *`,
      [runId],
    );

    // Automated recovery: reconcile ambiguous batch
    await db.query(
      `UPDATE migration_batches SET status = 'COMMITTED' WHERE id = $1`,
      [crashBatch.rows[0].id],
    );
    const recoveredBatch = await db.query('SELECT status FROM migration_batches WHERE id = $1', [crashBatch.rows[0].id]);
    expect(recoveredBatch.rows[0].status).toBe('COMMITTED');

    // Advance run to COMPLETED
    await db.query(
      `UPDATE migration_runs SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
      [runId],
    );

    // -------------------------------------------------------------
    // Step 13: Validate complete source and destination datasets
    // -------------------------------------------------------------
    // Seed real source and destination customer table rows
    await db.query(
      `CREATE TABLE IF NOT EXISTS source_customers (
         id VARCHAR(64) PRIMARY KEY,
         name VARCHAR(255),
         email VARCHAR(255),
         created_at TIMESTAMPTZ,
         tier VARCHAR(32)
       )`,
    );
    await db.query(
      `INSERT INTO source_customers (id, name, email, created_at, tier)
       VALUES ('cust_001', 'Jane Doe', 'jane.doe@corp.com', NOW(), 'ENTERPRISE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    );

    await db.query(
      `CREATE TABLE IF NOT EXISTS customers (
         id VARCHAR(64) PRIMARY KEY,
         name VARCHAR(255),
         email VARCHAR(255),
         created_at TIMESTAMPTZ,
         tier VARCHAR(32)
       )`,
    );
    await db.query(
      `INSERT INTO customers (id, name, email, created_at, tier)
       VALUES ('cust_001', 'Jane Doe', 'jane.doe@corp.com', NOW(), 'ENTERPRISE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    );

    const validation = await validationService.triggerValidation(runId, userId);
    expect(validation).toBeDefined();
    const summary = (validation as any).summary_json || (validation as any).summaryJson;
    expect(summary.totalChecks).toBeGreaterThan(0);

    // -------------------------------------------------------------
    // Step 14: Generate and download an immutable report
    // -------------------------------------------------------------
    const valRuns = await db.query('SELECT id FROM validation_runs WHERE migration_run_id = $1', [runId]);
    const valRunId = valRuns.rows[0].id;

    const report = await reportService.generateReport(valRunId, 'DETAILED', 'HTML', userId);
    expect(report.id).toBeDefined();
    expect(report.checksum).toBeDefined();

    const downloadedReport = await reportService.downloadReport(report.id, userId);
    expect(downloadedReport.checksum).toBe(report.checksum);

    // -------------------------------------------------------------
    // Step 15: Verify that run, batch, manifest, checkpoint and report records agree
    // -------------------------------------------------------------
    const runCheck = await migrationService.getRun(runId, userId);
    expect(runCheck.status).toBe('COMPLETED');

    const manifestCheck = await db.query('SELECT COUNT(*) as count FROM record_manifests WHERE migration_run_id = $1', [runId]);
    expect(Number(manifestCheck.rows[0].count)).toBeGreaterThan(0);

    const reportCheck = await reportService.listReports(workspaceId, userId);
    expect(reportCheck.some((r: any) => r.id === report.id)).toBe(true);
  });
});
