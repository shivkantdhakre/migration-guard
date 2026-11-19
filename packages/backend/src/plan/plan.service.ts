import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ProjectService } from '../project/project.service';
import { CreatePlanVersionDto } from './plan.dto';
import { CryptoUtil } from '../common/crypto/crypto.util';

@Injectable()
export class PlanService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    private projectService: ProjectService,
  ) {}

  async createPlan(projectId: string, name: string, userId: string) {
    const project = await this.projectService.getProject(projectId, userId);
    await this.workspaceService.assertWorkspaceAccess(project.workspace_id, userId, 'Engineer');

    const res = await this.db.query(
      `INSERT INTO migration_plans (workspace_id, project_id, name, status, current_version, created_by)
       VALUES ($1, $2, $3, 'DRAFT', 1, $4)
       RETURNING *`,
      [project.workspace_id, projectId, name, userId],
    );

    return res.rows[0];
  }

  async getPlan(planId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM migration_plans WHERE id = $1', [planId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Migration plan not found.');
    }
    const plan = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(plan.workspace_id, userId, 'Viewer');

    // Fetch plan versions
    const versionsRes = await this.db.query(
      'SELECT id, plan_id, version, plan_hash, created_at FROM migration_plan_versions WHERE plan_id = $1 ORDER BY version DESC',
      [planId],
    );

    return {
      ...plan,
      versions: versionsRes.rows,
    };
  }

  async createPlanVersion(planId: string, dto: CreatePlanVersionDto, userId: string) {
    const planRes = await this.db.query('SELECT * FROM migration_plans WHERE id = $1', [planId]);
    if (planRes.rows.length === 0) {
      throw new NotFoundException('Migration plan not found.');
    }
    const plan = planRes.rows[0];
    await this.workspaceService.assertWorkspaceAccess(plan.workspace_id, userId, 'Engineer');

    if (!dto.sourceConnectionId || !dto.destinationConnectionId) {
      throw new BadRequestException('sourceConnectionId and destinationConnectionId are required.');
    }

    // Determine version number
    const countRes = await this.db.query(
      'SELECT COUNT(*) as count FROM migration_plan_versions WHERE plan_id = $1',
      [planId],
    );
    const versionNumber = parseInt(countRes.rows[0].count, 10) + 1;

    // Build canonical plan data object to compute canonical hash
    const canonicalPayload = {
      planId,
      version: versionNumber,
      sourceConnectionId: dto.sourceConnectionId,
      sourceSchemaSnapshotId: dto.sourceSchemaSnapshotId || null,
      destinationConnectionId: dto.destinationConnectionId,
      destinationSchemaSnapshotId: dto.destinationSchemaSnapshotId || null,
      mappingVersionId: dto.mappingVersionId || null,
      scope: dto.scope || {},
      executionConfig: dto.executionConfig || { batchSize: 1000, concurrency: 4, writeMode: 'UPSERT' },
      validationProfile: dto.validationProfile || {},
    };

    const planHash = CryptoUtil.canonicalHash(canonicalPayload);

    const insertRes = await this.db.query(
      `INSERT INTO migration_plan_versions (
         plan_id, version, source_connection_id, source_schema_snapshot_id,
         destination_connection_id, destination_schema_snapshot_id, mapping_version_id,
         scope_json, execution_config_json, validation_profile_json, plan_hash, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        planId,
        versionNumber,
        dto.sourceConnectionId,
        dto.sourceSchemaSnapshotId || null,
        dto.destinationConnectionId,
        dto.destinationSchemaSnapshotId || null,
        dto.mappingVersionId || null,
        dto.scope || {},
        dto.executionConfig || {},
        dto.validationProfile || {},
        planHash,
        userId,
      ],
    );

    // Update plan's current_version
    await this.db.query(
      'UPDATE migration_plans SET current_version = $1, updated_at = NOW() WHERE id = $2',
      [versionNumber, planId],
    );

    return insertRes.rows[0];
  }

  async getPlanVersion(versionId: string, userId: string) {
    const res = await this.db.query(
      `SELECT mpv.*, mp.workspace_id, mp.project_id, mp.name as plan_name
       FROM migration_plan_versions mpv
       JOIN migration_plans mp ON mpv.plan_id = mp.id
       WHERE mpv.id = $1`,
      [versionId],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }
    const version = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(version.workspace_id, userId, 'Viewer');

    return version;
  }
}
