import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';

@Injectable()
export class ProjectService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
  ) {}

  async listProjects(workspaceId: string, userId: string) {
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');
    const res = await this.db.query(
      'SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId],
    );
    return res.rows;
  }

  async createProject(
    workspaceId: string,
    name: string,
    description: string | undefined,
    userId: string,
  ) {
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Engineer');
    const res = await this.db.query(
      'INSERT INTO projects (workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [workspaceId, name, description || '', userId],
    );
    return res.rows[0];
  }

  async getProject(projectId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Project not found.');
    }
    const project = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(project.workspace_id, userId, 'Viewer');
    return project;
  }

  async updateProject(
    projectId: string,
    updates: { name?: string; description?: string; status?: string },
    userId: string,
  ) {
    const project = await this.getProject(projectId, userId);
    await this.workspaceService.assertWorkspaceAccess(project.workspace_id, userId, 'Engineer');

    const name = updates.name !== undefined ? updates.name : project.name;
    const desc = updates.description !== undefined ? updates.description : project.description;
    const status = updates.status !== undefined ? updates.status : project.status;

    const res = await this.db.query(
      'UPDATE projects SET name = $1, description = $2, status = $3 WHERE id = $4 RETURNING *',
      [name, desc, status, projectId],
    );
    return res.rows[0];
  }

  async getActivity(projectId: string, userId: string) {
    const project = await this.getProject(projectId, userId);
    await this.workspaceService.assertWorkspaceAccess(project.workspace_id, userId, 'Viewer');

    const res = await this.db.query(
      'SELECT * FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50',
      [projectId],
    );
    return res.rows;
  }
}
