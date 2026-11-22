import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';

export interface DiscrepancyFilter {
  category?: string;
  severity?: string;
  status?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class DiscrepancyService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
  ) {}

  async listDiscrepancies(validationRunId: string, filter: DiscrepancyFilter = {}, userId?: string) {
    if (userId) {
      const vRunRes = await this.db.query('SELECT workspace_id FROM validation_runs WHERE id = $1', [validationRunId]);
      if (vRunRes.rows.length === 0) {
        throw new NotFoundException('Validation run not found.');
      }
      await this.workspaceService.assertWorkspaceAccess(vRunRes.rows[0].workspace_id, userId, 'Viewer');
    }
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM discrepancies WHERE validation_run_id = $1';
    const params: any[] = [validationRunId];
    let paramIdx = 2;

    if (filter.category) {
      if (filter.category === 'ATTACHMENT' || filter.category === 'MISSING_ATTACHMENT') {
        query += ` AND (category = 'ATTACHMENT' OR category = 'MISSING_ATTACHMENT')`;
      } else if (filter.category === 'DUPLICATE' || filter.category === 'DUPLICATE_RECORD') {
        query += ` AND (category = 'DUPLICATE' OR category = 'DUPLICATE_RECORD')`;
      } else if (filter.category === 'RELATIONSHIP' || filter.category === 'BROKEN_REFERENCE') {
        query += ` AND (category = 'RELATIONSHIP' OR category = 'BROKEN_REFERENCE')`;
      } else if (filter.category === 'METADATA' || filter.category === 'METADATA_MISMATCH') {
        query += ` AND (category = 'METADATA' OR category = 'METADATA_MISMATCH')`;
      } else {
        query += ` AND category = $${paramIdx++}`;
        params.push(filter.category);
      }
    }
    if (filter.severity) {
      query += ` AND severity = $${paramIdx++}`;
      params.push(filter.severity);
    }
    if (filter.status) {
      query += ` AND status = $${paramIdx++}`;
      params.push(filter.status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const res = await this.db.query(query, params);

    // Count
    let countQuery = 'SELECT COUNT(*) as count FROM discrepancies WHERE validation_run_id = $1';
    const countParams: any[] = [validationRunId];
    let cIdx = 2;
    if (filter.category) {
      if (filter.category === 'ATTACHMENT' || filter.category === 'MISSING_ATTACHMENT') {
        countQuery += ` AND (category = 'ATTACHMENT' OR category = 'MISSING_ATTACHMENT')`;
      } else if (filter.category === 'DUPLICATE' || filter.category === 'DUPLICATE_RECORD') {
        countQuery += ` AND (category = 'DUPLICATE' OR category = 'DUPLICATE_RECORD')`;
      } else if (filter.category === 'RELATIONSHIP' || filter.category === 'BROKEN_REFERENCE') {
        countQuery += ` AND (category = 'RELATIONSHIP' OR category = 'BROKEN_REFERENCE')`;
      } else if (filter.category === 'METADATA' || filter.category === 'METADATA_MISMATCH') {
        countQuery += ` AND (category = 'METADATA' OR category = 'METADATA_MISMATCH')`;
      } else {
        countQuery += ` AND category = $${cIdx++}`;
        countParams.push(filter.category);
      }
    }
    if (filter.severity) {
      countQuery += ` AND severity = $${cIdx++}`;
      countParams.push(filter.severity);
    }
    if (filter.status) {
      countQuery += ` AND status = $${cIdx++}`;
      countParams.push(filter.status);
    }

    const countRes = await this.db.query(countQuery, countParams);

    return {
      discrepancies: res.rows,
      pagination: {
        total: parseInt(countRes.rows[0].count, 10),
        page,
        limit,
      },
    };
  }

  async getDiscrepancy(discrepancyId: string, userId?: string) {
    const res = await this.db.query(
      `SELECT d.*, vr.workspace_id
       FROM discrepancies d
       JOIN validation_runs vr ON d.validation_run_id = vr.id
       WHERE d.id = $1`,
      [discrepancyId],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException('Discrepancy not found.');
    }
    const discrepancy = res.rows[0];
    if (userId) {
      await this.workspaceService.assertWorkspaceAccess(discrepancy.workspace_id, userId, 'Viewer');
    }
    return discrepancy;
  }

  async updateDiscrepancyStatus(
    discrepancyId: string,
    status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'IGNORED',
    comment?: string,
    userId?: string,
  ) {
    const existing = await this.getDiscrepancy(discrepancyId, userId);
    if (userId) {
      await this.workspaceService.assertWorkspaceAccess(existing.workspace_id, userId, 'Engineer');
    }

    const validStatuses = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(`Invalid discrepancy status '${status}'. Must be one of: ${validStatuses.join(', ')}.`);
    }

    // Enforce valid state transitions (Section 1.3)
    if (existing.status === 'RESOLVED' && status === 'ACKNOWLEDGED') {
      throw new BadRequestException('Cannot transition a RESOLVED discrepancy to ACKNOWLEDGED; reopen to OPEN first.');
    }
    if (existing.status === 'IGNORED' && status === 'ACKNOWLEDGED') {
      throw new BadRequestException('Cannot transition an IGNORED discrepancy to ACKNOWLEDGED; reopen to OPEN first.');
    }

    const summary = comment ? `${existing.summary} [Note: ${comment}]` : existing.summary;

    const res = await this.db.query(
      'UPDATE discrepancies SET status = $1, summary = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, summary, discrepancyId],
    );

    if (userId) {
      await this.db.query(
        `INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
         VALUES ($1, 'USER', $2, $3, 'DISCREPANCY', $4, $5)`,
        [
          existing.workspace_id,
          userId,
          `DISCREPANCY_STATUS_${status}`,
          discrepancyId,
          { previousStatus: existing.status, newStatus: status, comment },
        ],
      );
    }

    return res.rows[0];
  }
}
