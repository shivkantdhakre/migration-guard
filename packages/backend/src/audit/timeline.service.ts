import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';

@Injectable()
export class TimelineService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
  ) {}

  async getWorkspaceAuditEvents(workspaceId: string, limit = 50, userId: string) {
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT ae.*, u.email as actor_email, u.name as actor_name
       FROM audit_events ae
       LEFT JOIN users u ON ae.actor_id = u.id
       WHERE ae.workspace_id = $1
       ORDER BY ae.created_at DESC
       LIMIT $2`,
      [workspaceId, limit],
    );
    return res.rows;
  }

  async getProjectAuditEvents(projectId: string, limit = 50, userId: string) {
    const projRes = await this.db.query('SELECT workspace_id FROM projects WHERE id = $1', [projectId]);
    if (projRes.rows.length === 0) {
      return [];
    }
    const workspaceId = projRes.rows[0].workspace_id;
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT ae.*, u.email as actor_email, u.name as actor_name
       FROM audit_events ae
       LEFT JOIN users u ON ae.actor_id = u.id
       WHERE ae.project_id = $1
       ORDER BY ae.created_at DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return res.rows;
  }
}
