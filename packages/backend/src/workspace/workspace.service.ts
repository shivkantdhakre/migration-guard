import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UserRole } from '../auth/decorators/roles.decorator';

const ROLE_RANKS: Record<UserRole, number> = {
  Owner: 4,
  Admin: 3,
  Engineer: 2,
  Viewer: 1,
};

@Injectable()
export class WorkspaceService {
  constructor(private db: DatabaseService) {}

  async listWorkspacesForUser(userId: string) {
    const res = await this.db.query(
      `SELECT w.id, w.name, w.slug, w.status, w.created_at, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [userId],
    );
    return res.rows;
  }

  async createWorkspace(name: string, slug: string, userId: string) {
    const existing = await this.db.query('SELECT id FROM workspaces WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      throw new ConflictException(`Workspace with slug "${slug}" already exists.`);
    }

    const wsRes = await this.db.query(
      'INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status, created_at',
      [name, slug],
    );
    const workspace = wsRes.rows[0];

    // Creator is assigned Owner
    await this.db.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspace.id, userId, 'Owner'],
    );

    return { ...workspace, role: 'Owner' };
  }

  async getWorkspace(workspaceId: string, userId: string) {
    await this.assertWorkspaceAccess(workspaceId, userId, 'Viewer');
    const res = await this.db.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Workspace not found.');
    }
    return res.rows[0];
  }

  async listMembers(workspaceId: string, userId: string) {
    await this.assertWorkspaceAccess(workspaceId, userId, 'Viewer');
    const res = await this.db.query(
      `SELECT wm.id, wm.workspace_id, wm.user_id, wm.role, wm.created_at, u.email, u.name
       FROM workspace_members wm
       JOIN users u ON wm.user_id = u.id
       WHERE wm.workspace_id = $1
       ORDER BY wm.created_at ASC`,
      [workspaceId],
    );
    return res.rows;
  }

  async addMember(workspaceId: string, userEmail: string, role: UserRole, requestingUserId: string) {
    await this.assertWorkspaceAccess(workspaceId, requestingUserId, 'Admin');

    const userRes = await this.db.query('SELECT id, email, name FROM users WHERE email = $1', [
      userEmail,
    ]);
    if (userRes.rows.length === 0) {
      throw new NotFoundException(`User with email "${userEmail}" not found.`);
    }
    const targetUser = userRes.rows[0];

    const existingMember = await this.db.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, targetUser.id],
    );
    if (existingMember.rows.length > 0) {
      throw new ConflictException('User is already a member of this workspace.');
    }

    const res = await this.db.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) RETURNING id, workspace_id, user_id, role, created_at',
      [workspaceId, targetUser.id, role],
    );

    return {
      ...res.rows[0],
      email: targetUser.email,
      name: targetUser.name,
    };
  }

  async updateMemberRole(
    workspaceId: string,
    memberId: string,
    newRole: UserRole,
    requestingUserId: string,
  ) {
    await this.assertWorkspaceAccess(workspaceId, requestingUserId, 'Admin');

    const memberRes = await this.db.query(
      'SELECT * FROM workspace_members WHERE id = $1 AND workspace_id = $2',
      [memberId, workspaceId],
    );
    if (memberRes.rows.length === 0) {
      throw new NotFoundException('Workspace member not found.');
    }

    const updateRes = await this.db.query(
      'UPDATE workspace_members SET role = $1 WHERE id = $2 RETURNING id, workspace_id, user_id, role',
      [newRole, memberId],
    );

    return updateRes.rows[0];
  }

  public async resolveWorkspaceId(workspaceId: string, userId: string): Promise<string> {
    if (workspaceId === 'default') {
      const defaultWs = await this.db.query(
        'SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
        [userId],
      );
      if (defaultWs.rows.length > 0) {
        return defaultWs.rows[0].workspace_id;
      }
      const anyWs = await this.db.query('SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1');
      if (anyWs.rows.length > 0) {
        return anyWs.rows[0].id;
      }
      throw new ForbiddenException('No active workspace found.');
    }
    return workspaceId;
  }

  public async assertWorkspaceAccess(
    workspaceId: string,
    userId: string,
    minRole: UserRole = 'Viewer',
  ): Promise<UserRole> {
    const resolvedId = await this.resolveWorkspaceId(workspaceId, userId);
    const res = await this.db.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [resolvedId, userId],
    );

    if (res.rows.length === 0) {
      throw new ForbiddenException(
        `Workspace isolation: access denied to workspace ${workspaceId}. User is not a member.`,
      );
    }

    const role = res.rows[0].role as UserRole;
    if (ROLE_RANKS[role] < ROLE_RANKS[minRole]) {
      throw new ForbiddenException(
        `Insufficient role in workspace. Required minimum: ${minRole}, current: ${role}`,
      );
    }

    return role;
  }
}
