import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { DslValidatorService } from './dsl-validator.service';
import { MappingPreviewService } from './mapping-preview.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

@Injectable()
export class MappingService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    private dslValidator: DslValidatorService,
    private previewService: MappingPreviewService,
  ) {}

  async createMappingProfile(projectId: string, planId: string, userId: string) {
    const projRes = await this.db.query('SELECT workspace_id FROM projects WHERE id = $1', [projectId]);
    if (projRes.rows.length === 0) {
      throw new NotFoundException('Project not found.');
    }
    const workspaceId = projRes.rows[0].workspace_id;
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Engineer');

    const defaultDsl = {
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

    return this.createVersion(planId, defaultDsl, userId);
  }

  async createVersion(planId: string, mappingJson: any, userId: string) {
    // Assert DSL validity
    this.dslValidator.assertValid(mappingJson);

    // Compute canonical hash
    const mappingHash = CryptoUtil.canonicalHash(mappingJson);

    // Fetch plan
    const planRes = await this.db.query('SELECT workspace_id FROM migration_plans WHERE id = $1', [planId]);
    if (planRes.rows.length === 0) {
      throw new NotFoundException('Migration plan not found.');
    }
    const workspaceId = planRes.rows[0].workspace_id;
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Engineer');

    // Determine version number
    const countRes = await this.db.query(
      'SELECT COUNT(*) as count FROM mapping_versions WHERE plan_id = $1',
      [planId],
    );
    const version = parseInt(countRes.rows[0].count, 10) + 1;

    const res = await this.db.query(
      `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [workspaceId, planId, version, mappingJson, mappingHash, userId],
    );

    return res.rows[0];
  }

  async getVersion(versionId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM mapping_versions WHERE id = $1', [versionId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Mapping version not found.');
    }
    const version = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(version.workspace_id, userId, 'Viewer');
    return version;
  }

  async listMappingsForProject(projectId: string, userId: string) {
    const projRes = await this.db.query('SELECT workspace_id FROM projects WHERE id = $1', [projectId]);
    if (projRes.rows.length === 0) {
      throw new NotFoundException('Project not found.');
    }
    const workspaceId = projRes.rows[0].workspace_id;
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT mv.*, mp.name as plan_name, mp.project_id
       FROM mapping_versions mv
       JOIN migration_plans mp ON mp.id = mv.plan_id
       WHERE mp.project_id = $1
       ORDER BY mv.created_at DESC`,
      [projectId],
    );
    return res.rows;
  }

  async listMappingsForWorkspace(workspaceId: string, userId: string) {
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT mv.*, mp.name as plan_name, mp.project_id
       FROM mapping_versions mv
       JOIN migration_plans mp ON mp.id = mv.plan_id
       WHERE mv.workspace_id = $1
       ORDER BY mv.created_at DESC`,
      [workspaceId],
    );
    return res.rows;
  }

  async listMappingsForPlan(planId: string, userId: string) {
    const planRes = await this.db.query('SELECT workspace_id FROM migration_plans WHERE id = $1', [planId]);
    if (planRes.rows.length === 0) {
      throw new NotFoundException('Migration plan not found.');
    }
    const workspaceId = planRes.rows[0].workspace_id;
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');

    const res = await this.db.query(
      'SELECT * FROM mapping_versions WHERE plan_id = $1 ORDER BY version DESC',
      [planId],
    );
    return res.rows;
  }

  async validateVersion(versionId: string, userId: string) {
    const version = await this.getVersion(versionId, userId);
    return this.dslValidator.validateMappingDsl(version.mapping_json);
  }

  async previewTransformation(versionId: string, sampleRecords: any[], userId: string) {
    const version = await this.getVersion(versionId, userId);
    const preview = this.previewService.preview(version.mapping_json, sampleRecords);
    return {
      versionId,
      mappingHash: version.mapping_hash,
      preview,
    };
  }
}
