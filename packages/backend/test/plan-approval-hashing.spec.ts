import { describe, it, expect, beforeEach } from 'vitest';
import { PlanService } from '../src/plan/plan.service';
import { ApprovalService } from '../src/plan/approval.service';
import { ReadinessService } from '../src/plan/readiness.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { MigrationService } from '../src/migration/migration.service';
import { ProgressService } from '../src/migration/progress.service';
import { ConnectionService } from '../src/connection/connection.service';
import { CredentialsService } from '../src/connection/credentials.service';
import { ProjectService } from '../src/project/project.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('Plan Approval & Canonical Hashing', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let connectionService: ConnectionService;
  let planService: PlanService;
  let approvalService: ApprovalService;
  let readinessService: ReadinessService;
  let dryRunService: DryRunService;
  let migrationService: MigrationService;
  let progressService: ProgressService;
  let authService: AuthService;

  let user: any;
  let workspaceId: string;
  let project: any;
  let sourceConn: any;
  let destConn: any;
  let plan: any;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    const credentialsService = new CredentialsService(db);
    connectionService = new ConnectionService(db, workspaceService, credentialsService);

    planService = new PlanService(db, workspaceService, projectService);
    approvalService = new ApprovalService(db, workspaceService);
    readinessService = new ReadinessService(db);
    dryRunService = new DryRunService(db);
    migrationService = new MigrationService(db, workspaceService);
    progressService = new ProgressService(db);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    const email = `lead_${Date.now()}_${Math.random().toString(36).slice(2)}@corp.com`;
    user = await authService.register(email, 'Tech Lead', 'SecurePassword!');
    workspaceId = user.workspace.id;

    project = await projectService.createProject(workspaceId, 'E-Commerce Modernization', 'Mongo to PG', user.user.id);

    sourceConn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'Mongo Source',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { host: 'mongo.internal' },
        credentials: { username: 'u', password: 'p' },
      },
      user.user.id,
    );

    destConn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'Postgres Dest',
        engine: 'POSTGRESQL',
        connectionRole: 'DESTINATION',
        config: { host: 'pg.internal' },
        credentials: { username: 'u', password: 'p' },
      },
      user.user.id,
    );

    plan = await planService.createPlan(project.id, 'Core Migration Plan', user.user.id);
  });

  it('should compute deterministic canonical plan hash and create plan version', async () => {
    const version = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: sourceConn.id,
        destinationConnectionId: destConn.id,
        scope: { collections: ['customers', 'orders'] },
        executionConfig: { batchSize: 1000, concurrency: 4, writeMode: 'UPSERT' },
        validationProfile: {
          countCheck: true,
          missingRecordCheck: true,
          extraRecordCheck: true,
          duplicateCheck: true,
          contentHashCheck: true,
          fieldValidation: true,
          attachmentCheck: true,
          relationshipCheck: true,
          metadataCheck: true,
        },
      },
      user.user.id,
    );

    expect(version.plan_hash).toBeDefined();
    expect(version.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(version.version).toBe(1);
  });

  it('should run deterministic readiness check and dry run', async () => {
    const version = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: sourceConn.id,
        destinationConnectionId: destConn.id,
        scope: { collections: ['customers'] },
        executionConfig: { batchSize: 500, concurrency: 2, writeMode: 'UPSERT' },
        validationProfile: { countCheck: true } as any,
      },
      user.user.id,
    );

    const readiness = await readinessService.checkReadiness(version.id);
    expect(readiness.ready).toBe(true);
    expect(readiness.facts.length).toBeGreaterThan(0);

    const dryRun = await dryRunService.startDryRun(version.id);
    expect(dryRun.status).toBe('COMPLETED');
    expect(dryRun.sampleRecordsTested).toBe(500);
    expect(dryRun.readyForApproval).toBe(true);
  });

  it('should reject approval when submitted hash differs from canonical plan hash', async () => {
    const version = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: sourceConn.id,
        destinationConnectionId: destConn.id,
        scope: { collections: ['customers'] },
        executionConfig: { batchSize: 1000, concurrency: 2, writeMode: 'INSERT_ONLY' },
        validationProfile: { countCheck: true } as any,
      },
      user.user.id,
    );

    const forgedHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    await expect(
      approvalService.submitApproval(
        version.id,
        {
          planHash: forgedHash,
          decision: 'APPROVE',
          comment: 'Approved with bad hash',
        },
        user.user.id,
      ),
    ).rejects.toThrow('The submitted plan hash does not match the canonical hash');
  });

  it('should block starting migration run when plan is not approved', async () => {
    const version = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: sourceConn.id,
        destinationConnectionId: destConn.id,
        scope: { collections: ['customers'] },
        executionConfig: { batchSize: 1000, concurrency: 2, writeMode: 'UPSERT' },
        validationProfile: { countCheck: true } as any,
      },
      user.user.id,
    );

    // Try starting without approval -> must throw PLAN_NOT_APPROVED
    await expect(migrationService.startMigrationRun(version.id, user.user.id)).rejects.toThrow(
      'Cannot execute migration: plan version has not received explicit approval',
    );
  });

  it('should successfully approve with exact hash and execute migration run with progress tracking', async () => {
    const version = await planService.createPlanVersion(
      plan.id,
      {
        sourceConnectionId: sourceConn.id,
        destinationConnectionId: destConn.id,
        scope: { collections: ['customers'] },
        executionConfig: { batchSize: 1000, concurrency: 4, writeMode: 'UPSERT' },
        validationProfile: { countCheck: true } as any,
      },
      user.user.id,
    );

    // 1. Approve with exact canonical hash
    const approval = await approvalService.submitApproval(
      version.id,
      {
        planHash: version.plan_hash,
        decision: 'APPROVE',
        comment: 'Verified schemas and dry-run outcomes; approved for execution.',
      },
      user.user.id,
    );

    expect(approval.approval_status).toBe('APPROVE');
    expect(approval.resource_hash).toBe(version.plan_hash);

    // 2. Start migration run
    const runResult = await migrationService.startMigrationRun(version.id, user.user.id);
    expect(runResult.status).toBe('QUEUED');
    expect(runResult.runId).toBeDefined();

    // 3. Batches exist
    const batchesRes = await migrationService.listBatches(runResult.runId, 1, 10, user.user.id);
    expect(batchesRes.batches.length).toBe(10);
    expect(batchesRes.batches[0].batch_key).toBe('batch_0001');

    // 4. Progress service returns metrics
    const progress = await progressService.getProgress(runResult.runId);
    expect(progress.status).toBe('QUEUED');
    expect(progress.runId).toBe(runResult.runId);

    // 5. Pause and Resume lifecycle
    const pauseRes = await migrationService.pauseRun(runResult.runId, user.user.id);
    expect(pauseRes.status).toBe('PAUSED');

    const resumeRes = await migrationService.resumeRun(runResult.runId, user.user.id);
    expect(resumeRes.status).toBe('RUNNING');
  });
});
