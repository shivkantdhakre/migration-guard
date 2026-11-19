import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { TimelineService } from '../src/audit/timeline.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('Audit Events & Timeline', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let auditService: AuditService;
  let timelineService: TimelineService;
  let authService: AuthService;
  let user: any;
  let workspaceId: string;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    auditService = new AuditService(db);
    timelineService = new TimelineService(db, workspaceService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    const email = `compliance_${Date.now()}_${Math.random().toString(36).slice(2)}@corp.com`;
    user = await authService.register(email, 'Compliance Officer', 'Pass123!');
    workspaceId = user.workspace.id;
  });

  it('should log immutable audit events with sanitized details and retrieve timeline', async () => {
    // 1. Log privileged mutation with potentially sensitive fields
    const testResourceId = crypto.randomUUID ? crypto.randomUUID() : 'a0000000-0000-0000-0000-000000000123';
    const event = await auditService.log({
      workspaceId,
      actorType: 'USER',
      actorId: user.user.id,
      action: 'CONNECTION_CREDENTIALS_ROTATED',
      resourceType: 'CONNECTION',
      resourceId: testResourceId,
      correlationId: 'corr_abc',
      details: {
        engine: 'MONGODB',
        credentialVersion: 2,
        password: 'DoNotEverLeakThisPasswordInAuditLogs!',
        apiSecretKey: 'SecretKey123',
        status: 'SUCCESS',
      },
    });

    expect(event.id).toBeDefined();
    expect(event.action).toBe('CONNECTION_CREDENTIALS_ROTATED');

    // CRITICAL: secrets in details_json must be redacted!
    expect(event.details_json.password).toBe('[REDACTED]');
    expect(event.details_json.apiSecretKey).toBe('[REDACTED]');
    expect(event.details_json.engine).toBe('MONGODB');
    expect(event.details_json.status).toBe('SUCCESS');

    // 2. Query timeline for workspace
    const timeline = await timelineService.getWorkspaceAuditEvents(workspaceId, 10, user.user.id);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0].action).toBe('CONNECTION_CREDENTIALS_ROTATED');
    expect(timeline[0].details_json.password).toBe('[REDACTED]');
  });
});
