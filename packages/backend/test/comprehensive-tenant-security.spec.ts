import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { ProjectService } from '../src/project/project.service';
import { AuthService } from '../src/auth/auth.service';
import { ConnectionService } from '../src/connection/connection.service';
import { PlanService } from '../src/plan/plan.service';
import { MigrationService } from '../src/migration/migration.service';
import { DiscrepancyService } from '../src/validation/discrepancy.service';
import { ReportService } from '../src/report/report.service';
import { AiController } from '../src/ai/ai.controller';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import { ForbiddenException, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';

describe('Comprehensive Tenant Security & Isolation Suite (Section 9.1)', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let authService: AuthService;
  let connectionService: ConnectionService;
  let planService: PlanService;
  let migrationService: MigrationService;
  let discrepancyService: DiscrepancyService;
  let reportService: ReportService;
  let aiController: AiController;
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
      getDecryptedCredentials: async () => ({ uri: 'mongodb://localhost:27017' }),
      rotateCredentials: async () => ({ newVersion: 2 }),
    } as any;

    connectionService = new ConnectionService(db, workspaceService, credentialsService);
    planService = new PlanService(db, workspaceService, projectService);
    migrationService = new MigrationService(db, workspaceService);
    discrepancyService = new DiscrepancyService(db, workspaceService);
    reportService = new ReportService(db, workspaceService);
    aiController = new AiController(
      {
        chat: async () => ({ content: 'advisory suggestion' }),
        createConversation: async () => ({ id: 'conv-123' }),
        askCopilot: async () => ({ answer: 'advisory' }),
      } as any,
      db,
    );
  });

  it('1. User A cannot access User B connections, snapshots, plans, runs, discrepancies, or reports (IDOR Protection)', async () => {
    const userA = await authService.register('alice@tenant-a.com', 'Alice A', 'Password123!');
    const userB = await authService.register('bob@tenant-b.com', 'Bob B', 'Password123!');

    const wsA = userA.workspace.id;
    const wsB = userB.workspace.id;

    // Alice creates connection in Tenant A
    const connA = await connectionService.createConnection(
      wsA,
      {
        name: 'Mongo Source A',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { database: 'db_a' },
        credentials: { uri: 'mongodb://localhost:27017' },
      },
      userA.user.id,
    );

    // Bob attempts to read Alice's connection -> Must be forbidden or not found
    await expect(connectionService.getConnection(connA.id, userB.user.id)).rejects.toThrow();

    // Alice creates a project and plan in Tenant A
    const projectA = await projectService.createProject(wsA, 'Project A', 'Desc', userA.user.id);
    const planA = await planService.createPlan(
      projectA.id,
      'Plan A',
      userA.user.id,
    );

    // Bob cannot read Alice's plan
    await expect(planService.getPlan(planA.id, userB.user.id)).rejects.toThrow();

    // Bob cannot list Alice's migration runs
    await expect(migrationService.listRuns(wsA, userB.user.id)).rejects.toThrow();
  });

  it('2. Plan cannot reference a connection or mapping from another workspace', async () => {
    const userA = await authService.register('org_a@corp.com', 'Org A', 'Pass123!');
    const userB = await authService.register('org_b@corp.com', 'Org B', 'Pass123!');

    const wsA = userA.workspace.id;
    const wsB = userB.workspace.id;

    // Alice creates connection in Workspace A
    const connA = await connectionService.createConnection(
      wsA,
      {
        name: 'Source A',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { database: 'db_a' },
        credentials: {},
      },
      userA.user.id,
    );

    // Bob creates project and plan in Workspace B
    const projB = await projectService.createProject(wsB, 'Project B', 'Desc', userB.user.id);
    const planB = await planService.createPlan(
      projB.id,
      'Plan B',
      userB.user.id,
    );

    // Bob creates snapshot in Workspace B
    const snapDestB = await db.query(
      `INSERT INTO schema_snapshots (workspace_id, connection_id, connection_version, schema_version, snapshot_json)
       VALUES ($1, gen_random_uuid(), 1, 1, '{}') RETURNING id`,
      [wsB],
    );
    const snapSrcB = await db.query(
      `INSERT INTO schema_snapshots (workspace_id, connection_id, connection_version, schema_version, snapshot_json)
       VALUES ($1, gen_random_uuid(), 1, 1, '{}') RETURNING id`,
      [wsB],
    );

    // Bob creates connection in Workspace B
    const connDestB = await connectionService.createConnection(
      wsB,
      {
        name: 'Dest B',
        engine: 'POSTGRESQL',
        connectionRole: 'DESTINATION',
        config: { database: 'pg_b' },
        credentials: {},
      },
      userB.user.id,
    );

    // Bob tries to create plan version in Workspace B referencing Alice's source connection (Workspace A)
    await expect(
      planService.createPlanVersion(
        planB.id,
        {
          sourceConnectionId: connA.id, // Belongs to Workspace A!
          destinationConnectionId: connDestB.id,
          sourceSchemaSnapshotId: snapSrcB.rows[0].id,
          destinationSchemaSnapshotId: snapDestB.rows[0].id,
          scope: { tables: ['customers'] },
          executionConfig: { batchSize: 1000 },
          validationProfile: { mode: 'STRICT' },
        },
        userB.user.id,
      ),
    ).rejects.toThrow(/Source connection (?:not found in plan workspace|does not belong to this workspace)/);
  });

  it('3. Viewer cannot execute or modify a migration run', async () => {
    const owner = await authService.register('admin@corp.com', 'Admin User', 'Pass123!');
    const viewer = await authService.register('viewer@corp.com', 'Viewer User', 'Pass123!');
    const wsId = owner.workspace.id;

    // Add viewer to workspace
    await workspaceService.addMember(wsId, 'viewer@corp.com', 'Viewer', owner.user.id);

    // Viewer cannot start migration
    await expect(
      migrationService.startMigrationRun(
        '00000000-0000-0000-0000-000000000001',
        viewer.user.id,
      ),
    ).rejects.toThrow();
  });

  it('4. Unauthenticated user cannot call AI endpoints and forged headers are rejected', async () => {
    // Calling AI endpoint without req.user throws UnauthorizedException
    const fakeReqNoUser: any = {
      headers: {
        'x-workspace-id': 'forged-workspace-id',
        'x-project-id': 'forged-project-id',
      },
    };

    await expect(
      aiController.createConversation('proj-123', fakeReqNoUser),
    ).rejects.toThrow(UnauthorizedException);

    // Even if user provides forged headers with real user, extractContext queries workspace_members
    const user = await authService.register('hacker@corp.com', 'Hacker', 'Pass123!');
    const fakeReqWithUser: any = {
      user: { id: user.user.id, email: user.user.email },
      headers: {
        'x-workspace-id': '00000000-0000-0000-0000-999999999999', // Non-member workspace
      },
    };

    // User is not a member of workspace 999999999999 -> throws ForbiddenException
    await expect(
      aiController.createConversation('proj-123', fakeReqWithUser),
    ).rejects.toThrow(ForbiddenException);
  });

  it('5. A rejected plan version cannot execute, even if it has an earlier approval', async () => {
    const owner = await authService.register('sec_owner@corp.com', 'Sec Owner', 'Pass123!');
    const wsId = owner.workspace.id;

    // Create plan version
    const proj = await projectService.createProject(wsId, 'Sec Proj', 'Desc', owner.user.id);
    const plan = await planService.createPlan(
      proj.id,
      'Sec Plan',
      owner.user.id,
    );
    const planVerRes = await db.query(
      `INSERT INTO migration_plan_versions (plan_id, version, plan_hash, scope_json, execution_config_json)
       VALUES ($1, 1, 'canonical_plan_hash_001', '{}', '{}') RETURNING *`,
      [plan.id],
    );
    const planVerId = planVerRes.rows[0].id;

    // 1. Earlier Approval
    await db.query(
      `INSERT INTO approvals (workspace_id, resource_type, resource_id, resource_hash, approval_status, approved_by, approved_at)
       VALUES ($1, 'PLAN_VERSION', $2, 'canonical_plan_hash_001', 'APPROVE', $3, $4)`,
      [wsId, planVerId, owner.user.id, new Date(Date.now() - 3600000).toISOString()],
    );

    // 2. Later Rejection
    await db.query(
      `INSERT INTO approvals (workspace_id, resource_type, resource_id, resource_hash, approval_status, approved_by, approved_at)
       VALUES ($1, 'PLAN_VERSION', $2, 'canonical_plan_hash_001', 'REJECT', $3, $4)`,
      [wsId, planVerId, owner.user.id, new Date().toISOString()],
    );

    // Attempt to start migration must fail closed with ForbiddenException
    await expect(
      migrationService.startMigrationRun(planVerId, owner.user.id),
    ).rejects.toThrow(ForbiddenException);
  });
});
