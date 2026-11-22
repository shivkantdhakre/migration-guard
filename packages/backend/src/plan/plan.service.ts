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

  async listPlansForProject(projectId: string, userId: string) {
    const project = await this.projectService.getProject(projectId, userId);
    await this.workspaceService.assertWorkspaceAccess(project.workspace_id, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT mp.*, (
         SELECT json_agg(json_build_object(
           'id', mpv.id,
           'version', mpv.version,
           'planHash', mpv.plan_hash,
           'sourceConnectionId', mpv.source_connection_id,
           'destinationConnectionId', mpv.destination_connection_id,
           'status', mpv.status,
           'createdAt', mpv.created_at
         ))
         FROM migration_plan_versions mpv
         WHERE mpv.plan_id = mp.id
       ) as versions
       FROM migration_plans mp
       WHERE mp.project_id = $1
       ORDER BY mp.created_at DESC`,
      [project.id],
    );
    return res.rows;
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

    // Enforce workspace ownership and role/engine compatibility for connections (Section 1.1)
    const sourceConnRes = await this.db.query(
      'SELECT * FROM connections WHERE id = $1 AND workspace_id = $2',
      [dto.sourceConnectionId, plan.workspace_id],
    );
    if (sourceConnRes.rows.length === 0) {
      throw new BadRequestException('Source connection not found in plan workspace.');
    }
    const sourceConn = sourceConnRes.rows[0];
    if (sourceConn.connection_role !== 'SOURCE') {
      throw new BadRequestException(`Source connection role must be SOURCE (got ${sourceConn.connection_role}).`);
    }
    if (sourceConn.engine !== 'MONGODB') {
      throw new BadRequestException(`Source connection engine must be MONGODB (got ${sourceConn.engine}).`);
    }

    const destConnRes = await this.db.query(
      'SELECT * FROM connections WHERE id = $1 AND workspace_id = $2',
      [dto.destinationConnectionId, plan.workspace_id],
    );
    if (destConnRes.rows.length === 0) {
      throw new BadRequestException('Destination connection not found in plan workspace.');
    }
    const destConn = destConnRes.rows[0];
    if (destConn.connection_role !== 'DESTINATION') {
      throw new BadRequestException(`Destination connection role must be DESTINATION (got ${destConn.connection_role}).`);
    }
    if (destConn.engine !== 'POSTGRESQL') {
      throw new BadRequestException(`Destination connection engine must be POSTGRESQL (got ${destConn.engine}).`);
    }

    // Validate snapshots belong to selected connections and workspace
    if (dto.sourceSchemaSnapshotId) {
      const srcSnapRes = await this.db.query(
        'SELECT * FROM schema_snapshots WHERE id = $1 AND workspace_id = $2 AND connection_id = $3',
        [dto.sourceSchemaSnapshotId, plan.workspace_id, dto.sourceConnectionId],
      );
      if (srcSnapRes.rows.length === 0) {
        throw new BadRequestException('Source schema snapshot does not belong to selected source connection or workspace.');
      }
    }

    if (dto.destinationSchemaSnapshotId) {
      const destSnapRes = await this.db.query(
        'SELECT * FROM schema_snapshots WHERE id = $1 AND workspace_id = $2 AND connection_id = $3',
        [dto.destinationSchemaSnapshotId, plan.workspace_id, dto.destinationConnectionId],
      );
      if (destSnapRes.rows.length === 0) {
        throw new BadRequestException('Destination schema snapshot does not belong to selected destination connection or workspace.');
      }
    }

    // Validate mapping version belongs to plan workspace
    if (dto.mappingVersionId) {
      const mapRes = await this.db.query(
        'SELECT * FROM mapping_versions WHERE id = $1 AND workspace_id = $2',
        [dto.mappingVersionId, plan.workspace_id],
      );
      if (mapRes.rows.length === 0) {
        throw new BadRequestException('Mapping version does not belong to plan workspace.');
      }
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
