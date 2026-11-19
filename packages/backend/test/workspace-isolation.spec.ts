import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('WorkspaceIsolation', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let authService: AuthService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);
  });

  it('should isolate workspaces so User A cannot access Workspace B', async () => {
    const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userA = await authService.register(`usera_${rand}@corp.com`, 'User A', 'Pass123!');
    const userB = await authService.register(`userb_${rand}@corp.com`, 'User B', 'Pass123!');

    const wsAId = userA.workspace.id;
    const wsBId = userB.workspace.id;

    // User A can access their own workspace
    const wsA = await workspaceService.getWorkspace(wsAId, userA.user.id);
    expect(wsA.id).toBe(wsAId);

    // User A is forbidden from accessing User B's workspace
    await expect(workspaceService.getWorkspace(wsBId, userA.user.id)).rejects.toThrow(
      'Workspace isolation: access denied',
    );
  });

  it('should enforce workspace roles and permissions', async () => {
    const rand2 = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const viewerEmail = `viewer_${rand2}@corp.com`;
    const owner = await authService.register(`owner_${rand2}@corp.com`, 'Owner', 'Pass123!');
    const member = await authService.register(viewerEmail, 'Viewer', 'Pass123!');
    const wsId = owner.workspace.id;

    // Add member as Viewer
    await workspaceService.addMember(wsId, viewerEmail, 'Viewer', owner.user.id);

    // Viewer can read workspace
    const ws = await workspaceService.getWorkspace(wsId, member.user.id);
    expect(ws.id).toBe(wsId);

    // Viewer cannot add other members (requires Admin)
    await expect(
      workspaceService.addMember(wsId, 'other@corp.com', 'Viewer', member.user.id),
    ).rejects.toThrow('Insufficient role in workspace');

    // Owner can promote Viewer to Admin
    const members = await workspaceService.listMembers(wsId, owner.user.id);
    const viewerMember = members.find((m: any) => m.user_id === member.user.id);
    expect(viewerMember).toBeDefined();

    const updated = await workspaceService.updateMemberRole(
      wsId,
      viewerMember.id,
      'Admin',
      owner.user.id,
    );
    expect(updated.role).toBe('Admin');
  });
});
