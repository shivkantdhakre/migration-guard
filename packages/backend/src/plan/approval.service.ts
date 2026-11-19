import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ApprovalDto } from './plan.dto';

@Injectable()
export class ApprovalService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
  ) {}

  async submitApproval(
    planVersionId: string,
    dto: ApprovalDto,
    userId: string,
  ) {
    const versionRes = await this.db.query(
      `SELECT mpv.*, mp.workspace_id
       FROM migration_plan_versions mpv
       JOIN migration_plans mp ON mpv.plan_id = mp.id
       WHERE mpv.id = $1`,
      [planVersionId],
    );

    if (versionRes.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }

    const version = versionRes.rows[0];
    const workspaceId = version.workspace_id;

    // Verify Admin or Owner role for approvals
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Admin');

    // Canonical plan hash verification: CRITICAL SAFETY CHECK
    if (dto.planHash !== version.plan_hash) {
      throw new UnprocessableEntityException({
        code: 'PLAN_HASH_MISMATCH',
        message: 'The submitted plan hash does not match the canonical hash of this plan version.',
        details: {
          submittedHash: dto.planHash,
          expectedCanonicalHash: version.plan_hash,
        },
      });
    }

    // Persist approval record
    const approvalRes = await this.db.query(
      `INSERT INTO approvals (workspace_id, resource_type, resource_id, resource_hash, approval_status, approver_user_id, comment)
       VALUES ($1, 'PLAN_VERSION', $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        workspaceId,
        planVersionId,
        version.plan_hash,
        dto.decision,
        userId,
        dto.comment || '',
      ],
    );

    const approval = approvalRes.rows[0];

    // If approved, update migration_plans status to APPROVED
    if (dto.decision === 'APPROVE') {
      await this.db.query(
        'UPDATE migration_plans SET status = $1, updated_at = NOW() WHERE id = $2',
        ['APPROVED', version.plan_id],
      );
    }

    // Append to audit events
    await this.db.query(
      `INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
       VALUES ($1, 'USER', $2, $3, 'PLAN_VERSION', $4, $5)`,
      [
        workspaceId,
        userId,
        `PLAN_VERSION_${dto.decision}`,
        planVersionId,
        { planHash: version.plan_hash, comment: dto.comment, decision: dto.decision },
      ],
    );

    return approval;
  }

  async getApprovalsForVersion(planVersionId: string, userId: string) {
    const versionRes = await this.db.query(
      `SELECT mp.workspace_id
       FROM migration_plan_versions mpv
       JOIN migration_plans mp ON mpv.plan_id = mp.id
       WHERE mpv.id = $1`,
      [planVersionId],
    );

    if (versionRes.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }

    await this.workspaceService.assertWorkspaceAccess(versionRes.rows[0].workspace_id, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT a.*, u.email as approver_email, u.name as approver_name
       FROM approvals a
       JOIN users u ON a.approver_user_id = u.id
       WHERE a.resource_type = 'PLAN_VERSION' AND a.resource_id = $1
       ORDER BY a.approved_at DESC`,
      [planVersionId],
    );

    return res.rows;
  }
}
