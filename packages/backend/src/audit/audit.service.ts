import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

export interface LogAuditOptions {
  workspaceId: string;
  projectId?: string;
  actorType?: 'USER' | 'SYSTEM' | 'API_KEY';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId?: string;
  details?: Record<string, any>;
}

@Injectable()
export class AuditService {
  constructor(private db: DatabaseService) {}

  /**
   * Appends an immutable audit event to the audit_events table.
   * Details are automatically sanitized to prevent secret leaks.
   */
  async log(opts: LogAuditOptions) {
    const sanitizedDetails = opts.details ? CryptoUtil.redactSecrets(opts.details) : {};

    const res = await this.db.query(
      `INSERT INTO audit_events (
         workspace_id, project_id, actor_type, actor_id,
         action, resource_type, resource_id, correlation_id, details_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        opts.workspaceId,
        opts.projectId || null,
        opts.actorType || 'USER',
        opts.actorId,
        opts.action,
        opts.resourceType,
        opts.resourceId,
        opts.correlationId || null,
        sanitizedDetails,
      ],
    );

    return res.rows[0];
  }
}
