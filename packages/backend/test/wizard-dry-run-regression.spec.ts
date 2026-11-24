import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolvePlanVersionId,
  evaluateDryRunResponse,
  canTransitionWizardStep,
  WizardStepGateState,
} from '../../frontend/lib/wizard-utils';
import { DryRunService } from '../src/plan/dry-run.service';
import { PlanService } from '../src/plan/plan.service';
import { ApprovalService } from '../src/plan/approval.service';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { CredentialsService } from '../src/connection/credentials.service';
import { ConnectionService } from '../src/connection/connection.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe('Priority 1: Wizard Dry-Run Integration & Fail-Closed Regression Suite', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let planService: PlanService;
  let approvalService: ApprovalService;
  let dryRunService: DryRunService;
  let connectionService: ConnectionService;
  let authService: AuthService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    const credentialsService = new CredentialsService(db);
    connectionService = new ConnectionService(db, workspaceService, credentialsService);
    dryRunService = new DryRunService(db, workspaceService, credentialsService);
    planService = new PlanService(db, workspaceService, projectService);
    approvalService = new ApprovalService(db, workspaceService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);
  });

  afterEach(async () => {
    await db?.onModuleDestroy();
  });

  describe('1. Version ID Resolution (Preventing plan.id and versionId conflation)', () => {
    it('resolves explicit versionId when present', () => {
      const plan = {
        id: 'plan-container-999',
        versionId: 'plan-version-uuid-001',
        name: 'Production Migration Plan',
        status: 'DRAFT',
      } as any;

      const resolved = resolvePlanVersionId(plan);
      expect(resolved).toBe('plan-version-uuid-001');
      expect(resolved).not.toBe(plan.id);
    });

    it('resolves latest version ID from plan versions array', () => {
      const plan = {
        id: 'plan-container-999',
        name: 'Production Migration Plan',
        versions: [
          { id: 'ver-001', version: 1 },
          { id: 'ver-002', version: 2 },
        ],
      } as any;

      const resolved = resolvePlanVersionId(plan);
      expect(resolved).toBe('ver-002');
      expect(resolved).not.toBe(plan.id);
    });

    it('returns null when neither versionId nor versions array exist (never defaults to plan.id)', () => {
      const plan = {
        id: 'plan-container-999',
        name: 'Production Migration Plan',
      } as any;

      const resolved = resolvePlanVersionId(plan);
      expect(resolved).toBeNull();
    });

    it('returns null for empty, null, or undefined plans', () => {
      expect(resolvePlanVersionId(null)).toBeNull();
      expect(resolvePlanVersionId(undefined)).toBeNull();
      expect(resolvePlanVersionId({} as any)).toBeNull();
    });
  });

  describe('2. Elimination of False-Success Paths & Metrics Validation (evaluateDryRunResponse)', () => {
    const validFacts = {
      sampleRecordsTested: 500,
      recordsTransformed: 500,
      transformationErrors: 0,
      measuredDurationMs: 45,
      measuredRatePerSec: 11111,
    };

    it('Case 1: Successful Dry-Run with valid metrics evaluates to true', () => {
      const mockSuccess = {
        id: 'dry_123',
        planVersionId: 'plan-version-uuid-001',
        planHash: 'sha256:canonicalplanhash123',
        status: 'COMPLETED',
        readyForApproval: true,
        sampleRecordsTested: 500,
        recordsTransformed: 500,
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: validFacts,
      };

      const result = evaluateDryRunResponse(mockSuccess);
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it('Case 2: Failed Validation with Transformation Errors rejects success', () => {
      const mockFailure = {
        id: 'dry_124',
        planVersionId: 'ver-001',
        planHash: 'sha256:abc',
        status: 'FAILED',
        readyForApproval: false,
        transformationErrors: 5,
        potentialTypeConflicts: [],
        measuredFacts: { ...validFacts, transformationErrors: 5 },
      };

      const result = evaluateDryRunResponse(mockFailure);
      expect(result.success).toBe(false);
      expect(result.error).toContain('status is \'FAILED\'');
    });

    it('Case 3: Failed Validation with Destination Schema Conflicts rejects success', () => {
      const mockFailure = {
        id: 'dry_125',
        planVersionId: 'ver-001',
        planHash: 'sha256:abc',
        status: 'COMPLETED',
        readyForApproval: false,
        transformationErrors: 0,
        potentialTypeConflicts: [{ destinationColumn: 'email', reason: 'Type mismatch' }],
        measuredFacts: validFacts,
      };

      const result = evaluateDryRunResponse(mockFailure);
      expect(result.success).toBe(false);
      expect(result.error).toContain('readyForApproval is false');
    });

    it('Case 4: Unexpected Response Shape (null, undefined, non-object) fails closed', () => {
      expect(evaluateDryRunResponse(null).success).toBe(false);
      expect(evaluateDryRunResponse(undefined).success).toBe(false);
      expect(evaluateDryRunResponse('Internal Server Error').success).toBe(false);
      expect(evaluateDryRunResponse([]).success).toBe(false);
      expect(evaluateDryRunResponse(null).error).toContain('response was empty or malformed');
    });

    it('Case 5: Missing readyForApproval property strictly rejects', () => {
      const buggyPayload = {
        status: 'COMPLETED',
        planHash: 'sha256:abc',
        recordsTransformed: 500,
        measuredFacts: validFacts,
      };

      const result = evaluateDryRunResponse(buggyPayload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('readyForApproval is false');
    });

    it('Case 6: Missing or empty planHash strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        sampleRecordsTested: 500,
        recordsTransformed: 500,
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: validFacts,
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing or malformed planHash');
    });

    it('Case 7: Missing or non-object measuredFacts strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        sampleRecordsTested: 500,
        recordsTransformed: 500,
        transformationErrors: 0,
        potentialTypeConflicts: [],
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing or malformed measuredFacts');
    });

    it('Case 8: Malformed or non-numeric sampleRecordsTested metric strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: {
          ...validFacts,
          sampleRecordsTested: '500' as any, // String instead of number
        },
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('sampleRecordsTested metric is missing, invalid, or non-numeric');
    });

    it('Case 9: Malformed or non-numeric recordsTransformed metric strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: {
          ...validFacts,
          recordsTransformed: NaN,
        },
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('recordsTransformed metric is missing, invalid, or non-numeric');
    });

    it('Case 10: Non-positive or invalid measuredDurationMs strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: {
          ...validFacts,
          measuredDurationMs: 0,
        },
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('measuredDurationMs metric is missing, invalid, or non-numeric');
    });

    it('Case 11: Non-array potentialTypeConflicts strictly rejects', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        transformationErrors: 0,
        potentialTypeConflicts: null as any,
        measuredFacts: validFacts,
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('potentialTypeConflicts is missing or not an array');
    });

    it('Case 12: Transformation errors in measuredFacts strictly rejects approval', () => {
      const payload = {
        status: 'COMPLETED',
        readyForApproval: true,
        planHash: 'sha256:abc',
        transformationErrors: 3,
        potentialTypeConflicts: [],
        measuredFacts: {
          ...validFacts,
          transformationErrors: 3,
        },
      };

      const result = evaluateDryRunResponse(payload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('3 transformation errors');
    });
  });

  describe('3. Backend Route & Version Contract Verification', () => {
    it('backend startDryRun throws NotFoundException when plan container ID is used instead of planVersionId', async () => {
      const email = `test-eng1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@acme.com`;
      const userRes = await db.query(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, 'Test Eng', 'hash') RETURNING id",
        [email],
      );
      const userId = userRes.rows[0].id;

      const slug = `test-ws-dry-1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const wsRes = await db.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Test WS', $1) RETURNING id",
        [slug],
      );
      const wsId = wsRes.rows[0].id;

      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'Owner')",
        [wsId, userId],
      );

      const projRes = await db.query(
        "INSERT INTO projects (workspace_id, name, description) VALUES ($1, 'Test Project', 'test-proj') RETURNING id",
        [wsId],
      );
      const projId = projRes.rows[0].id;

      const planRes = await db.query(
        "INSERT INTO migration_plans (workspace_id, project_id, name) VALUES ($1, $2, 'Container Plan') RETURNING id",
        [wsId, projId],
      );
      const planId = planRes.rows[0].id;

      // Passing planId (the plan container ID) to startDryRun MUST FAIL with NotFoundException
      await expect(dryRunService.startDryRun(planId, userId)).rejects.toThrow('Plan version not found.');
    });

    it('backend startDryRun succeeds and returns measured facts & readyForApproval=true when valid planVersionId is used', async () => {
      const email = `test-eng2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@acme.com`;
      const userRes = await db.query(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, 'Test Eng 2', 'hash') RETURNING id",
        [email],
      );
      const userId = userRes.rows[0].id;

      const slug = `test-ws-dry-2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const wsRes = await db.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Test WS 2', $1) RETURNING id",
        [slug],
      );
      const wsId = wsRes.rows[0].id;

      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'Owner')",
        [wsId, userId],
      );

      const projRes = await db.query(
        "INSERT INTO projects (workspace_id, name, description) VALUES ($1, 'Test Project 2', 'test-proj-2') RETURNING id",
        [wsId],
      );
      const projId = projRes.rows[0].id;

      const planRes = await db.query(
        "INSERT INTO migration_plans (workspace_id, project_id, name) VALUES ($1, $2, 'Container Plan 2') RETURNING id",
        [wsId, projId],
      );
      const planId = planRes.rows[0].id;

      const srcConn = await connectionService.createConnection(
        wsId,
        {
          name: 'Src',
          engine: 'MONGODB',
          connectionRole: 'SOURCE',
          config: { database: 'appdb' },
          credentials: { uri: 'mongodb://localhost:27017' },
        },
        userId,
      );

      const dstConn = await connectionService.createConnection(
        wsId,
        {
          name: 'Dst',
          engine: 'POSTGRESQL',
          connectionRole: 'DESTINATION',
          config: { database: 'neondb', schema: 'public' },
          credentials: { connectionString: 'postgresql://localhost:5432/neondb' },
        },
        userId,
      );

      const planVer = await planService.createPlanVersion(
        planId,
        {
          sourceConnectionId: srcConn.id,
          destinationConnectionId: dstConn.id,
          scope: { tables: ['customers'] },
          executionConfig: { batchSize: 500, concurrency: 4, writeMode: 'UPSERT' },
        },
        userId,
      );
      const versionId = planVer.id;

      const dryRunResult = await dryRunService.startDryRun(versionId, userId);
      expect(dryRunResult).toBeDefined();
      expect(dryRunResult.planVersionId).toBe(versionId);
      expect(dryRunResult.status).toBe('COMPLETED');
      expect(dryRunResult.readyForApproval).toBe(true);
      expect(dryRunResult.transformationErrors).toBe(0);
      expect(dryRunResult.measuredFacts).toBeDefined();
      expect(dryRunResult.measuredFacts.sampleRecordsTested).toBeGreaterThanOrEqual(0);
      expect(dryRunResult.measuredFacts.recordsTransformed).toBeGreaterThanOrEqual(0);
      expect(dryRunResult.measuredFacts.transformationErrors).toBe(0);
      expect(dryRunResult.measuredFacts.measuredDurationMs).toBeGreaterThan(0);

      // Verify that evaluateDryRunResponse passes this result
      const evaluation = evaluateDryRunResponse(dryRunResult);
      expect(evaluation.success).toBe(true);
      expect(evaluation.error).toBeNull();
    });
  });

  describe('4. Centralized Wizard Stepper & Prerequisite Gating Verification', () => {
    const readyGateState: WizardStepGateState = {
      isDemo: false,
      sourceConnId: 'conn-src-1',
      targetConnId: 'conn-dst-1',
      sourceHandshakeSuccess: true,
      targetHandshakeSuccess: true,
      dryRunSuccess: true,
      isConfigModifiedSinceDryRun: false,
      planStatus: 'APPROVED',
      hasMigrationRun: true,
      migrationRunStatus: 'COMPLETED',
      hasValidationRun: true,
    };

    it('blocks Step 1->2 and Step 2->3 when connections are unselected', () => {
      expect(
        canTransitionWizardStep(2, 1, { ...readyGateState, sourceConnId: '' }).allowed,
      ).toBe(false);
      expect(
        canTransitionWizardStep(3, 2, { ...readyGateState, targetConnId: '' }).allowed,
      ).toBe(false);
    });

    it('blocks Step 3->4 and direct stepper jumps past Step 3 until dual handshake succeeds', () => {
      const noHandshake = { ...readyGateState, targetHandshakeSuccess: false };
      expect(canTransitionWizardStep(4, 3, noHandshake).allowed).toBe(false);
      expect(canTransitionWizardStep(8, 1, noHandshake).allowed).toBe(false);
      expect(canTransitionWizardStep(4, 3, readyGateState).allowed).toBe(true);
    });

    it('blocks Step 10->11 and direct Step 9->11 jump unless dry run passed on unmodified config', () => {
      expect(
        canTransitionWizardStep(11, 10, { ...readyGateState, dryRunSuccess: false }).allowed,
      ).toBe(false);
      expect(
        canTransitionWizardStep(11, 9, {
          ...readyGateState,
          dryRunSuccess: true,
          isConfigModifiedSinceDryRun: true,
        }).allowed,
      ).toBe(false);
      expect(canTransitionWizardStep(11, 10, readyGateState).allowed).toBe(true);
    });

    it('blocks direct jumps to Step 12 unless plan version is APPROVED in live mode', () => {
      expect(
        canTransitionWizardStep(12, 11, { ...readyGateState, planStatus: 'DRAFT' }).allowed,
      ).toBe(false);
      expect(
        canTransitionWizardStep(12, 5, { ...readyGateState, planStatus: 'DRAFT' }).allowed,
      ).toBe(false);
      expect(canTransitionWizardStep(12, 11, readyGateState).allowed).toBe(true);
    });

    it('blocks Step 12->13 validation jump until live migration run reaches COMPLETED', () => {
      for (const nonCompleted of ['QUEUED', 'RUNNING', 'PAUSED', 'FAILED']) {
        expect(
          canTransitionWizardStep(13, 12, {
            ...readyGateState,
            migrationRunStatus: nonCompleted,
          }).allowed,
        ).toBe(false);
      }
      expect(
        canTransitionWizardStep(13, 12, { ...readyGateState, hasMigrationRun: false }).allowed,
      ).toBe(false);
      expect(canTransitionWizardStep(13, 12, readyGateState).allowed).toBe(true);
    });

    it('blocks Step 13->14 audit export jump until validation run exists in live mode', () => {
      expect(
        canTransitionWizardStep(14, 13, { ...readyGateState, hasValidationRun: false }).allowed,
      ).toBe(false);
      expect(canTransitionWizardStep(14, 13, readyGateState).allowed).toBe(true);
    });

    it('always permits backward navigation and non-gated intermediate steps', () => {
      expect(
        canTransitionWizardStep(3, 12, {
          ...readyGateState,
          dryRunSuccess: false,
          planStatus: 'DRAFT',
        }).allowed,
      ).toBe(true);
      expect(
        canTransitionWizardStep(6, 5, {
          ...readyGateState,
          dryRunSuccess: false,
          planStatus: 'DRAFT',
          hasMigrationRun: false,
          hasValidationRun: false,
        }).allowed,
      ).toBe(true);
    });
  });

  describe('5. Real Database Integration: End-to-End Wizard Lifecycle', () => {
    it('executes full flow: registration -> connection -> plan -> plan-version -> dry-run -> metrics validation -> approval', async () => {
      // 1. Authenticate user
      const leadEmail = `wizard-lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@acme.corp`;
      const user = await authService.register(leadEmail, 'Lead Wizard Engineer', 'StrongPassword123!');
      const userId = user.user.id;
      const workspaceId = user.workspace.id;

      // 2. Create Project
      const project = await projectService.createProject(
        workspaceId,
        'Wizard E2E Project',
        'End-to-end integration test',
        userId,
      );
      expect(project.id).toBeDefined();

      // 3. Register Connections
      const sourceConn = await connectionService.createConnection(
        workspaceId,
        {
          name: 'MongoDB Source',
          engine: 'MONGODB',
          connectionRole: 'SOURCE',
          config: { database: 'appdb' },
          credentials: { uri: 'mongodb://localhost:27017' },
        },
        userId,
      );

      const destConn = await connectionService.createConnection(
        workspaceId,
        {
          name: 'Postgres Target',
          engine: 'POSTGRESQL',
          connectionRole: 'DESTINATION',
          config: { database: 'migrationguard_target', schema: 'public' },
          credentials: { connectionString: 'postgresql://postgres:postgres@localhost:5432/migrationguard_target' },
        },
        userId,
      );

      // 4. Create Plan Container
      const planContainer = await planService.createPlan(project.id, 'E2E Modernization Plan', userId);
      expect(planContainer.id).toBeDefined();

      // 5. Create Executable Plan Version with Canonical Hashing
      const planVersion = await planService.createPlanVersion(
        planContainer.id,
        {
          sourceConnectionId: sourceConn.id,
          destinationConnectionId: destConn.id,
          scope: { tables: ['customers'] },
          executionConfig: { batchSize: 500, concurrency: 4, writeMode: 'UPSERT' },
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
        userId,
      );
      expect(planVersion.id).toBeDefined();
      expect(planVersion.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Verify that resolvePlanVersionId correctly resolves versionId and never falls back to plan.id
      const resolved = resolvePlanVersionId({
        ...planContainer,
        versionId: planVersion.id,
        versions: [{ id: planVersion.id, version: 1, planHash: planVersion.plan_hash }],
      } as any);
      expect(resolved).toBe(planVersion.id);
      expect(resolved).not.toBe(planContainer.id);

      // 6. Execute Genuine Dry Run through DryRunService
      const dryRun = await dryRunService.startDryRun(planVersion.id, userId);
      expect(dryRun.status).toBe('COMPLETED');
      expect(dryRun.readyForApproval).toBe(true);
      expect(dryRun.planHash).toBe(planVersion.plan_hash);
      expect(dryRun.transformationErrors).toBe(0);
      expect(dryRun.measuredFacts.sampleRecordsTested).toBeGreaterThan(0);
      expect(dryRun.measuredFacts.recordsTransformed).toBeGreaterThan(0);
      expect(dryRun.measuredFacts.transformationErrors).toBe(0);
      expect(dryRun.measuredFacts.measuredDurationMs).toBeGreaterThan(0);

      // 7. Verify evaluateDryRunResponse strictly accepts this live dry run
      const evaluation = evaluateDryRunResponse(dryRun);
      expect(evaluation.success).toBe(true);
      expect(evaluation.error).toBeNull();

      // 8. Verify failure handling: attempting dry run with plan container ID throws NotFoundException
      await expect(dryRunService.startDryRun(planContainer.id, userId)).rejects.toThrow('Plan version not found.');

      // 9. Execute Plan Approval using exact versionId and planHash
      const approval = await approvalService.submitApproval(
        planVersion.id,
        {
          planHash: planVersion.plan_hash,
          decision: 'APPROVE',
          comment: 'Live E2E dry-run completed with 0 errors. Approved for cutover.',
        },
        userId,
      );
      expect(approval.approval_status).toBe('APPROVE');
      expect(approval.resource_hash).toBe(planVersion.plan_hash);

      // Verify the migration plan status transitioned to APPROVED
      const updatedPlanContainer = await planService.getPlan(planContainer.id, userId);
      expect(updatedPlanContainer.status).toBe('APPROVED');

      // 10. Verify durable approval record in database
      const approvalRecords = await db.query(
        'SELECT * FROM approvals WHERE resource_id = $1 AND approval_status = $2',
        [planVersion.id, 'APPROVE'],
      );
      expect(approvalRecords.rows.length).toBe(1);
      expect(approvalRecords.rows[0].resource_hash).toBe(planVersion.plan_hash);
      const approverId = approvalRecords.rows[0].approver_user_id || approvalRecords.rows[0].approved_by;
      expect(approverId).toBe(userId);
    });
  });
});
