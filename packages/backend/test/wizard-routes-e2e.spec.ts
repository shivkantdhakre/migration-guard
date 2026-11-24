import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { CredentialsService } from '../src/connection/credentials.service';
import { ConnectionService } from '../src/connection/connection.service';
import { AuthService } from '../src/auth/auth.service';
import { MappingService } from '../src/mapping/mapping.service';
import { MappingController } from '../src/mapping/mapping.controller';
import { DslValidatorService } from '../src/mapping/dsl-validator.service';
import { MappingPreviewService } from '../src/mapping/mapping-preview.service';
import { PlanService } from '../src/plan/plan.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { ApprovalService } from '../src/plan/approval.service';
import { MigrationService } from '../src/migration/migration.service';
import { ProgressService } from '../src/migration/progress.service';
import { ValidationService } from '../src/validation/validation.service';
import { DiscrepancyService } from '../src/validation/discrepancy.service';
import { ReportService } from '../src/report/report.service';
import { ReportController } from '../src/report/report.controller';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import { resolvePlanVersionId, evaluateDryRunResponse } from '../../frontend/lib/wizard-utils';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const REAL_MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL;
if (!REAL_MONGO_URI) {
  throw new Error(
    '[Security Guard] MONGODB_URI or MONGO_URL environment variable must be explicitly configured. Hardcoded database credentials are strictly forbidden.',
  );
}

describe('Wizard Routes & Service/Controller Integration Suite', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let credentialsService: CredentialsService;
  let connectionService: ConnectionService;
  let authService: AuthService;
  let dslValidator: DslValidatorService;
  let previewService: MappingPreviewService;
  let mappingService: MappingService;
  let mappingController: MappingController;
  let planService: PlanService;
  let dryRunService: DryRunService;
  let approvalService: ApprovalService;
  let migrationService: MigrationService;
  let progressService: ProgressService;
  let validationService: ValidationService;
  let discrepancyService: DiscrepancyService;
  let reportService: ReportService;
  let reportController: ReportController;

  let userA: any;
  let wsA: string;
  let userB: any;
  let wsB: string;

  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL;

  if (!targetDbUrl) {
    throw new Error(
      '[Safety Guard] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be explicitly configured. Running integration tests against default application database is strictly prohibited.',
    );
  }
  validateSafeTestDatabaseEndpoint(targetDbUrl);

  beforeEach(async () => {
    process.env.ALLOW_IN_MEMORY_DB = 'false';
    process.env.FORCE_POSTGRES_DB = 'true';
    process.env.ALLOW_SYNTHETIC_SOURCE = 'false';

    db = new DatabaseService(targetDbUrl);
    await db.onModuleInit();
    db.resetMemoryStore();

    // Ensure destination customers table exists with primary key
    await db.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        tier TEXT,
        created_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb
      )
    `);

    // Ensure sample documents exist in MongoDB source
    try {
      const { MongoClient } = require('mongodb');
      const mClient = new MongoClient(REAL_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      await mClient.connect();
      const coll = mClient.db('migrationguard_e2e_source').collection('customers');
      const cnt = await coll.countDocuments();
      if (cnt === 0) {
        await coll.insertMany([
          { _id: '507f1f77bcf86cd799439011', name: 'Acme Corporation', email: 'info@acme.corp', createdAt: '2026-11-20T12:00:00.000Z', metadata: { city: 'San Francisco', state: 'CA' } },
          { _id: '507f1f77bcf86cd799439012', name: 'Beta Industries', email: 'support@beta.io', createdAt: '2026-11-20T12:00:00.000Z', metadata: { city: 'Austin', state: 'TX' } },
        ]);
      }
      await mClient.close().catch(() => {});
    } catch (e: any) {
      console.warn(`[wizard-routes-e2e] Notice checking source MongoDB: ${e.message}`);
    }

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    credentialsService = new CredentialsService(db);
    connectionService = new ConnectionService(db, workspaceService, credentialsService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    dslValidator = new DslValidatorService();
    previewService = new MappingPreviewService();
    mappingService = new MappingService(db, workspaceService, dslValidator, previewService);
    mappingController = new MappingController(mappingService);

    planService = new PlanService(db, workspaceService, projectService);
    dryRunService = new DryRunService(db, workspaceService, credentialsService);
    approvalService = new ApprovalService(db, workspaceService);

    migrationService = new MigrationService(db, workspaceService);
    progressService = new ProgressService(db);
    validationService = new ValidationService(db, workspaceService, credentialsService);
    discrepancyService = new DiscrepancyService(db);

    reportService = new ReportService(db, workspaceService);
    reportController = new ReportController(reportService);

    const idA = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const idB = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    userA = await authService.register(`engineer-a-${idA}@corp.internal`, 'Engineer A', 'SecurePassword123!');
    wsA = userA.workspace.id;

    userB = await authService.register(`engineer-b-${idB}@corp.internal`, 'Engineer B', 'SecurePassword123!');
    wsB = userB.workspace.id;
  });

  afterEach(async () => {
    try {
      if (db?.isDbConnected) {
        await db.query(`DROP TABLE IF EXISTS customers CASCADE;`);
      }
    } catch {
      // Ignore teardown table errors
    } finally {
      await db?.onModuleDestroy();
    }
  });

  describe('1. Scoped Mapping Endpoints (Contract Gap Resolution)', () => {
    it('lists mappings by project and workspace, enforcing tenant isolation', async () => {
      // Create project in Workspace A
      const projA = await projectService.createProject(wsA, 'Modernization Proj A', 'Desc', userA.user.id);
      const planA = await planService.createPlan(projA.id, { name: 'E-Comm Plan A' }, userA.user.id);

      // Create a mapping version for Plan A
      const mappingVerA = await mappingService.createMappingProfile(projA.id, planA.id, userA.user.id);
      expect(mappingVerA.id).toBeDefined();
      expect(mappingVerA.plan_id).toBe(planA.id);

      // User A lists mappings for project
      const projMappings = await mappingController.listMappingsForProject(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        projA.id,
      );
      expect(projMappings.length).toBe(1);
      expect(projMappings[0].id).toBe(mappingVerA.id);

      // User A lists mappings for workspace
      const wsMappings = await mappingController.listMappingsForWorkspace(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        wsA,
      );
      expect(wsMappings.length).toBe(1);
      expect(wsMappings[0].id).toBe(mappingVerA.id);

      // User A lists mappings for plan
      const planMappings = await mappingController.listMappingsForPlan(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        planA.id,
      );
      expect(planMappings.length).toBe(1);
      expect(planMappings[0].id).toBe(mappingVerA.id);

      // User B (different workspace) attempts access -> strictly rejected
      await expect(
        mappingController.listMappingsForProject(
          { id: userB.user.id, email: userB.user.email, name: userB.user.name },
          projA.id,
        ),
      ).rejects.toThrow();

      await expect(
        mappingController.listMappingsForWorkspace(
          { id: userB.user.id, email: userB.user.email, name: userB.user.name },
          wsA,
        ),
      ).rejects.toThrow();

      await expect(
        mappingController.listMappingsForPlan(
          { id: userB.user.id, email: userB.user.email, name: userB.user.name },
          planA.id,
        ),
      ).rejects.toThrow();
    });
  });

  describe('2. Mapping Persistence, DSL Validation & Transformation Preview', () => {
    it('validates DSL allowlist and executes in-memory transformation preview', async () => {
      const proj = await projectService.createProject(wsA, 'Proj', 'Desc', userA.user.id);
      const plan = await planService.createPlan(proj.id, { name: 'Plan' }, userA.user.id);

      // Valid mapping DSL
      const validDsl = {
        version: 1,
        objects: [
          {
            source: { collection: 'customers' },
            destination: { schema: 'public', table: 'customers' },
            identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
            fields: [
              { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
              { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
              { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
              { sourcePath: 'metadata', destinationPath: 'metadata', transform: { op: 'TO_JSONB' } },
            ],
          },
        ],
      };

      const mappingVer = await mappingService.createVersion(plan.id, validDsl, userA.user.id);
      expect(mappingVer.id).toBeDefined();
      expect(mappingVer.version).toBe(1);

      // Validate mapping version
      const validation = await mappingController.validateMapping(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        mappingVer.id,
      );
      expect(validation.valid).toBe(true);
      expect(validation.issues.length).toBe(0);

      // Preview transformation on sample records
      const sampleDoc = {
        _id: '507f1f77bcf86cd799439011',
        name: '   Acme Corporation   ',
        email: 'INFO@ACME.CORP',
        createdAt: '2026-11-20T12:00:00.000Z',
        metadata: { city: 'San Francisco', state: 'CA' },
      };

      const previewRes = await mappingController.previewMapping(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        mappingVer.id,
        { sampleRecords: [sampleDoc] },
      );

      expect(previewRes.versionId).toBe(mappingVer.id);
      expect(previewRes.preview.length).toBe(1);
      const transformed = previewRes.preview[0].transformedRecord;
      expect(transformed.id).toBe('507f1f77bcf86cd799439011');
      expect(transformed.name).toBe('Acme Corporation');
      expect(transformed.email).toBe('info@acme.corp');
      expect(transformed.created_at).toBe('2026-11-20T12:00:00.000Z');
      expect(transformed.metadata).toEqual({ city: 'San Francisco', state: 'CA' });

      // Invalid operator in DSL should be rejected on creation
      const invalidDsl = {
        version: 1,
        objects: [
          {
            source: { collection: 'customers' },
            destination: { schema: 'public', table: 'customers' },
            fields: [
              { sourcePath: 'name', destinationPath: 'name', transform: { op: 'EXEC_ARBITRARY_SQL' } },
            ],
          },
        ],
      };

      await expect(
        mappingService.createVersion(plan.id, invalidDsl, userA.user.id),
      ).rejects.toThrow();
    });
  });

  describe('3. Plan Version Lifecycle & Live Dry-Run / Hash Approval', () => {
    it('executes live dry-run against real Atlas MongoDB & Neon PostgreSQL with ALLOW_SYNTHETIC_SOURCE=false', async () => {
      const proj = await projectService.createProject(wsA, 'E-Comm', 'Desc', userA.user.id);
      const plan = await planService.createPlan(proj.id, { name: 'Prod Plan' }, userA.user.id);

      // Real MongoDB Atlas Source Connection
      const srcConn = await connectionService.createConnection(
        wsA,
        {
          name: 'Mongo Atlas Live Source',
          engine: 'MONGODB',
          connectionRole: 'SOURCE',
          config: { database: 'migrationguard_e2e_source' },
          credentials: { uri: REAL_MONGO_URI },
        },
        userA.user.id,
      );

      // Real Neon PostgreSQL Destination Connection
      const dstConn = await connectionService.createConnection(
        wsA,
        {
          name: 'PG Neon Live Target',
          engine: 'POSTGRESQL',
          connectionRole: 'DESTINATION',
          config: { database: 'neondb', schema: 'public' },
          credentials: { connectionString: targetDbUrl },
        },
        userA.user.id,
      );

      const mappingVer = await mappingService.createMappingProfile(proj.id, plan.id, userA.user.id);

      // Create Plan Version 1 (batchSize: 500)
      const versionDto1 = {
        sourceConnectionId: srcConn.id,
        destinationConnectionId: dstConn.id,
        mappingVersionId: mappingVer.id,
        scope: { tables: ['customers'] },
        executionConfig: { batchSize: 500, concurrency: 4, writeMode: 'UPSERT' },
        validationProfile: { countCheck: true },
      };

      const planVer1 = await planService.createPlanVersion(plan.id, versionDto1, userA.user.id);
      expect(planVer1.id).toBeDefined();
      expect(planVer1.version).toBe(1);
      const hash1 = planVer1.plan_hash;

      // Resolving plan version correctly distinguishes plan.id vs versionId
      const resolved = resolvePlanVersionId({
        ...plan,
        versionId: planVer1.id,
        versions: [{ id: planVer1.id, version: 1, planHash: hash1 }],
      } as any);
      expect(resolved).toBe(planVer1.id);
      expect(resolved).not.toBe(plan.id);

      // Execute live dry-run on Version 1 (ALLOW_SYNTHETIC_SOURCE=false)
      const dryRun1 = await dryRunService.startDryRun(planVer1.id, userA.user.id);
      if (dryRun1.status !== 'COMPLETED') {
        console.error('DRY RUN 1 DEBUG:', JSON.stringify({
          status: dryRun1.status,
          readyForApproval: dryRun1.readyForApproval,
          errors: dryRun1.transformationErrors,
          conflicts: dryRun1.potentialTypeConflicts,
          objectsTested: dryRun1.objectsTested,
        }, null, 2));
      }
      expect(dryRun1.status).toBe('COMPLETED');
      expect(dryRun1.readyForApproval).toBe(true);
      expect(dryRun1.planHash).toBe(hash1);
      expect(dryRun1.measuredFacts.sampleRecordsTested).toBeGreaterThan(0);
      expect(dryRun1.measuredFacts.recordsTransformed).toBeGreaterThan(0);
      expect(dryRun1.measuredFacts.transformationErrors).toBe(0);

      const eval1 = evaluateDryRunResponse(dryRun1);
      expect(eval1.success).toBe(true);
      expect(eval1.error).toBeNull();

      // Simulate config change (batchSize: 1000) -> creates immutable Plan Version 2
      const versionDto2 = {
        ...versionDto1,
        executionConfig: { batchSize: 1000, concurrency: 8, writeMode: 'UPSERT' },
      };

      const planVer2 = await planService.createPlanVersion(plan.id, versionDto2, userA.user.id);
      expect(planVer2.id).toBeDefined();
      expect(planVer2.version).toBe(2);
      const hash2 = planVer2.plan_hash;
      expect(hash2).not.toBe(hash1);

      // Attempting to approve Plan Version 2 with stale hash1 must fail
      await expect(
        approvalService.submitApproval(
          planVer2.id,
          { planHash: hash1, decision: 'APPROVE', comment: 'Approving stale hash' },
          userA.user.id,
        ),
      ).rejects.toThrow(/does not match the canonical hash|Hash mismatch/i);

      // Execute dry run for Version 2 -> succeeds with hash2
      const dryRun2 = await dryRunService.startDryRun(planVer2.id, userA.user.id);
      expect(dryRun2.status).toBe('COMPLETED');
      expect(dryRun2.planHash).toBe(hash2);

      // Approve Version 2 with exact hash2
      const approval = await approvalService.submitApproval(
        planVer2.id,
        { planHash: hash2, decision: 'APPROVE', comment: 'Live approval with exact hash' },
        userA.user.id,
      );
      expect(approval.approval_status).toBe('APPROVE');
      expect(approval.resource_hash).toBe(hash2);
    });
  });

  describe('4. Fail-Closed on Unavailable Services', () => {
    it('verifies that unavailable services cause explicit failures with ALLOW_SYNTHETIC_SOURCE=false', async () => {
      const proj = await projectService.createProject(wsA, 'FailClosedProj', 'Desc', userA.user.id);
      const plan = await planService.createPlan(proj.id, { name: 'FailClosedPlan' }, userA.user.id);

      // Unreachable MongoDB port
      const unreachableSrc = await connectionService.createConnection(
        wsA,
        {
          name: 'Unreachable Mongo',
          engine: 'MONGODB',
          connectionRole: 'SOURCE',
          config: { database: 'offline_db' },
          credentials: { uri: 'mongodb://127.0.0.1:27099' },
        },
        userA.user.id,
      );

      const dstConn = await connectionService.createConnection(
        wsA,
        {
          name: 'PG Neon Live Target',
          engine: 'POSTGRESQL',
          connectionRole: 'DESTINATION',
          config: { database: 'neondb', schema: 'public' },
          credentials: { connectionString: targetDbUrl },
        },
        userA.user.id,
      );

      const mappingVer = await mappingService.createMappingProfile(proj.id, plan.id, userA.user.id);

      const planVer = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: unreachableSrc.id,
          destinationConnectionId: dstConn.id,
          mappingVersionId: mappingVer.id,
          scope: { tables: ['customers'] },
          executionConfig: { batchSize: 500, concurrency: 4, writeMode: 'UPSERT' },
          validationProfile: { countCheck: true },
        },
        userA.user.id,
      );

      // Must explicitly fail closed because ALLOW_SYNTHETIC_SOURCE=false and connection is unreachable
      await expect(
        dryRunService.startDryRun(planVer.id, userA.user.id),
      ).rejects.toThrow(/Cannot perform dry run|failed closed/i);
    });
  });

  describe('5. Service-Level Migration Dispatch, Validation & Durable Reports', () => {
    it(
      'orchestrates service-level migration run, progress polling, validation dispatch, and report generation',
      async () => {
      const proj = await projectService.createProject(wsA, 'CutoverProj', 'Desc', userA.user.id);
      const plan = await planService.createPlan(proj.id, { name: 'Cutover Plan' }, userA.user.id);

      const srcConn = await connectionService.createConnection(
        wsA,
        {
          name: 'Mongo Atlas Source',
          engine: 'MONGODB',
          connectionRole: 'SOURCE',
          config: { database: 'migrationguard_e2e_source' },
          credentials: { uri: REAL_MONGO_URI },
        },
        userA.user.id,
      );

      const dstConn = await connectionService.createConnection(
        wsA,
        {
          name: 'PG Neon Target',
          engine: 'POSTGRESQL',
          connectionRole: 'DESTINATION',
          config: { database: 'neondb', schema: 'public' },
          credentials: { connectionString: targetDbUrl },
        },
        userA.user.id,
      );

      const mappingVer = await mappingService.createMappingProfile(proj.id, plan.id, userA.user.id);

      const planVer = await planService.createPlanVersion(
        plan.id,
        {
          sourceConnectionId: srcConn.id,
          destinationConnectionId: dstConn.id,
          mappingVersionId: mappingVer.id,
          scope: { tables: ['customers'] },
          executionConfig: { batchSize: 500, concurrency: 4, writeMode: 'UPSERT' },
          validationProfile: { countCheck: true },
        },
        userA.user.id,
      );

      // Dry run & Approve
      const dryRun = await dryRunService.startDryRun(planVer.id, userA.user.id);
      await approvalService.submitApproval(
        planVer.id,
        { planHash: dryRun.planHash, decision: 'APPROVE', comment: 'Approved for run' },
        userA.user.id,
      );

      // Start Migration Run (calls POST /migration-runs)
      const run = await migrationService.startMigrationRun(planVer.id, userA.user.id);
      const runId = run.runId || (run as any).id;
      expect(runId).toBeDefined();
      expect(run.status).toBe('QUEUED');

      // Check Progress
      const progress = await progressService.getProgress(runId);
      expect(progress.runId).toBe(runId);

      // List Batches
      const batches = await migrationService.listBatches(runId, 1, 10, userA.user.id);
      expect(batches).toBeDefined();

      // Trigger Validation (calls POST /migration-runs/:runId/validations)
      const valRun = await validationService.triggerValidation(runId, userA.user.id);
      expect(valRun.id).toBeDefined();

      // List Discrepancies
      const discrepancies = await discrepancyService.listDiscrepancies(valRun.id, { page: 1, limit: 50 });
      expect(discrepancies).toBeDefined();

      // Generate HTML Executive Report via ReportController
      const htmlReport = await reportController.generateReport(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        valRun.id,
        { reportType: 'EXECUTIVE', format: 'HTML' },
      );
      expect(htmlReport.id).toBeDefined();
      expect(htmlReport.format).toBe('HTML');

      // Generate CSV Detailed Report via ReportController
      const csvReport = await reportController.generateReport(
        { id: userA.user.id, email: userA.user.email, name: userA.user.name },
        valRun.id,
        { reportType: 'DETAILED', format: 'CSV' },
      );
      expect(csvReport.id).toBeDefined();
      expect(csvReport.format).toBe('CSV');

      // Download Report content verification
      const downloadedHtml = await reportService.downloadReport(htmlReport.id, userA.user.id);
      expect(downloadedHtml.format).toBe('HTML');
      expect(downloadedHtml.content).toContain('<!DOCTYPE html>');

      const downloadedCsv = await reportService.downloadReport(csvReport.id, userA.user.id);
      expect(downloadedCsv.format).toBe('CSV');
      expect(typeof downloadedCsv.content).toBe('string');
    }, 120000);
  });
});
