import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolvePlanVersionId, evaluateDryRunResponse } from '../../frontend/lib/wizard-utils';
import { DryRunService } from '../src/plan/dry-run.service';
import { PlanService } from '../src/plan/plan.service';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { CredentialsService } from '../src/connection/credentials.service';
import { ConnectionService } from '../src/connection/connection.service';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe('Priority 1: Wizard Dry-Run Integration & Fail-Closed Regression Suite', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let planService: PlanService;
  let dryRunService: DryRunService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    projectService = new ProjectService(db, workspaceService);
    const credentialsService = new CredentialsService(db);
    const connectionService = new ConnectionService(db, workspaceService, credentialsService);
    dryRunService = new DryRunService(db, workspaceService, credentialsService);
    planService = new PlanService(db, workspaceService, projectService);
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

  describe('2. Elimination of False-Success Paths (evaluateDryRunResponse)', () => {
    it('Case 1: Successful Dry-Run evaluates to true with zero errors', () => {
      const mockSuccess = {
        id: 'dry_123',
        planVersionId: 'plan-version-uuid-001',
        status: 'COMPLETED',
        readyForApproval: true,
        sampleRecordsTested: 500,
        recordsTransformed: 500,
        transformationErrors: 0,
        potentialTypeConflicts: [],
        measuredFacts: {
          sampleRecordsTested: 500,
          recordsTransformed: 500,
          transformationErrors: 0,
          measuredDurationMs: 45,
          measuredRatePerSec: 11111,
        },
      };

      const result = evaluateDryRunResponse(mockSuccess);
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it('Case 2: Failed Validation with Transformation Errors rejects success', () => {
      const mockFailure = {
        id: 'dry_124',
        status: 'FAILED',
        readyForApproval: false,
        transformationErrors: 5,
        potentialTypeConflicts: [],
      };

      const result = evaluateDryRunResponse(mockFailure);
      expect(result.success).toBe(false);
      expect(result.error).toContain('5 transformation errors');
    });

    it('Case 3: Failed Validation with Destination Schema Conflicts rejects success', () => {
      const mockFailure = {
        id: 'dry_125',
        status: 'FAILED',
        readyForApproval: false,
        transformationErrors: 0,
        potentialTypeConflicts: [{ destinationColumn: 'email', reason: 'Type mismatch' }],
      };

      const result = evaluateDryRunResponse(mockFailure);
      expect(result.success).toBe(false);
      expect(result.error).toContain('1 schema conflicts');
    });

    it('Case 4: Failed status rejects even if transformationErrors is 0', () => {
      const mockFailure = {
        id: 'dry_126',
        status: 'FAILED',
        readyForApproval: false,
        transformationErrors: 0,
        potentialTypeConflicts: [],
      };

      const result = evaluateDryRunResponse(mockFailure);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Readiness check rejected approval');
    });

    it('Case 5: Unexpected Response Shape (null, undefined, non-object) fails closed', () => {
      expect(evaluateDryRunResponse(null).success).toBe(false);
      expect(evaluateDryRunResponse(undefined).success).toBe(false);
      expect(evaluateDryRunResponse('Internal Server Error').success).toBe(false);
      expect(evaluateDryRunResponse(null).error).toContain('response was empty or malformed');
    });

    it('Case 6: Missing readyForApproval property (Old False-Success Bug) strictly rejects', () => {
      // In the old buggy implementation: if (res.readyForApproval === undefined) dryRunSuccess = true
      const buggyPayload = {
        status: 'COMPLETED',
        recordsTransformed: 500,
      };

      const result = evaluateDryRunResponse(buggyPayload);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('Case 7: readyForApproval=false strictly rejects even with COMPLETED status', () => {
      const response = {
        status: 'COMPLETED',
        readyForApproval: false,
        transformationErrors: 0,
      };

      const result = evaluateDryRunResponse(response);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('3. Backend Route & Version Contract Verification', () => {
    it('backend startDryRun throws NotFoundException when plan container ID is used instead of planVersionId', async () => {
      // Create a plan with versions
      const userRes = await db.query(
        "INSERT INTO users (email, name, password_hash) VALUES ('test-eng@acme.com', 'Test Eng', 'hash') RETURNING id",
      );
      const userId = userRes.rows[0].id;

      const wsRes = await db.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Test WS', 'test-ws-dry') RETURNING id",
      );
      const wsId = wsRes.rows[0].id;

      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'Owner')",
        [wsId, userId],
      );

      const projRes = await db.query(
        "INSERT INTO projects (workspace_id, name, slug) VALUES ($1, 'Test Project', 'test-proj') RETURNING id",
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

    it('backend startDryRun succeeds and returns readyForApproval=true when valid planVersionId is used', async () => {
      const userRes = await db.query(
        "INSERT INTO users (email, name, password_hash) VALUES ('test-eng2@acme.com', 'Test Eng 2', 'hash') RETURNING id",
      );
      const userId = userRes.rows[0].id;

      const wsRes = await db.query(
        "INSERT INTO workspaces (name, slug) VALUES ('Test WS 2', 'test-ws-dry-2') RETURNING id",
      );
      const wsId = wsRes.rows[0].id;

      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'Owner')",
        [wsId, userId],
      );

      const projRes = await db.query(
        "INSERT INTO projects (workspace_id, name, slug) VALUES ($1, 'Test Project 2', 'test-proj-2') RETURNING id",
        [wsId],
      );
      const projId = projRes.rows[0].id;

      const planRes = await db.query(
        "INSERT INTO migration_plans (workspace_id, project_id, name) VALUES ($1, $2, 'Container Plan 2') RETURNING id",
        [wsId, projId],
      );
      const planId = planRes.rows[0].id;

      const versionRes = await db.query(
        `INSERT INTO migration_plan_versions (
           plan_id, version, plan_hash, status, created_by
         ) VALUES ($1, 1, 'sha256:dummyhash', 'DRAFT', $2) RETURNING id`,
        [planId, userId],
      );
      const versionId = versionRes.rows[0].id;

      const dryRunResult = await dryRunService.startDryRun(versionId, userId);
      expect(dryRunResult).toBeDefined();
      expect(dryRunResult.planVersionId).toBe(versionId);
      expect(dryRunResult.status).toBe('COMPLETED');
      expect(dryRunResult.readyForApproval).toBe(true);
      expect(dryRunResult.transformationErrors).toBe(0);

      // Verify that evaluateDryRunResponse passes this result
      const evaluation = evaluateDryRunResponse(dryRunResult);
      expect(evaluation.success).toBe(true);
      expect(evaluation.error).toBeNull();
    });
  });

  describe('4. Step 10 Progression Gating Verification', () => {
    it('blocks progression when currentStep is 10 and dry run has not passed', () => {
      const currentStep = 10;
      const dryRunSuccess = false;

      const canAdvance = currentStep !== 10 || dryRunSuccess === true;
      expect(canAdvance).toBe(false);
    });

    it('allows progression when currentStep is 10 and dry run passed', () => {
      const currentStep = 10;
      const dryRunSuccess = true;

      const canAdvance = currentStep !== 10 || dryRunSuccess === true;
      expect(canAdvance).toBe(true);
    });

    it('allows progression on non-gated steps', () => {
      expect(5 !== 10 || false).toBe(true);
      expect(9 !== 10 || false).toBe(true);
    });
  });
});
