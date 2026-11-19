import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface DiscrepancyFilter {
  category?: string;
  severity?: string;
  status?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class DiscrepancyService {
  constructor(private db: DatabaseService) {}

  async listDiscrepancies(validationRunId: string, filter: DiscrepancyFilter = {}) {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM discrepancies WHERE validation_run_id = $1';
    const params: any[] = [validationRunId];
    let paramIdx = 2;

    if (filter.category) {
      query += ` AND category = $${paramIdx++}`;
      params.push(filter.category);
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
      countQuery += ` AND category = $${cIdx++}`;
      countParams.push(filter.category);
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

  async getDiscrepancy(discrepancyId: string) {
    const res = await this.db.query('SELECT * FROM discrepancies WHERE id = $1', [discrepancyId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Discrepancy not found.');
    }
    return res.rows[0];
  }

  async updateDiscrepancyStatus(
    discrepancyId: string,
    status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'IGNORED',
    comment?: string,
  ) {
    const existing = await this.getDiscrepancy(discrepancyId);
    const summary = comment ? `${existing.summary} [Note: ${comment}]` : existing.summary;

    const res = await this.db.query(
      'UPDATE discrepancies SET status = $1, summary = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, summary, discrepancyId],
    );

    return res.rows[0];
  }
}
