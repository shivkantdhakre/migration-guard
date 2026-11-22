import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { AiService } from './ai.service.js';
import { ToolExecutionContext } from './types.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { DatabaseService } from '../database/database.service.js';

// Per-user and per-workspace rate limiter (FR-SEC / Section 1.2)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 60;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): void {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (entry.count >= MAX_REQUESTS_PER_MINUTE) {
    throw new ForbiddenException(`AI rate limit exceeded for ${key}. Try again in ${Math.ceil((entry.resetAt - now) / 1000)}s.`);
  }
  entry.count++;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly db: DatabaseService,
  ) {}

  private async extractContext(req: any): Promise<ToolExecutionContext> {
    const user = req?.user;
    if (!user || !user.id) {
      throw new UnauthorizedException('Authentication required to access AI capabilities.');
    }

    const userId = user.id;

    // Check rate limit per-user
    checkRateLimit(`user:${userId}`);

    // Resolve workspace membership securely from verified database record
    // NEVER trust client headers (x-workspace-id/x-project-id) or hardcoded defaults
    const requestedWorkspaceId =
      req?.headers?.['x-workspace-id'] ||
      req?.body?.workspaceId ||
      req?.query?.workspaceId ||
      req?.params?.workspaceId;

    let memberQuery = 'SELECT workspace_id, role FROM workspace_members WHERE user_id = $1';
    const params: any[] = [userId];

    if (requestedWorkspaceId) {
      memberQuery += ' AND workspace_id = $2';
      params.push(requestedWorkspaceId);
    }
    memberQuery += ' ORDER BY created_at ASC LIMIT 1';

    const memberRes = await this.db.query(memberQuery, params);
    if (memberRes.rows.length === 0) {
      throw new ForbiddenException('User is not authorized for the requested workspace.');
    }

    const membership = memberRes.rows[0];
    const resolvedWorkspaceId = membership.workspace_id;
    const resolvedRole = (membership.role || 'Viewer').toUpperCase();

    // Check rate limit per-workspace
    checkRateLimit(`workspace:${resolvedWorkspaceId}`);

    return {
      workspaceId: resolvedWorkspaceId,
      projectId: req?.body?.projectId || req?.params?.projectId || 'default-project',
      actorId: userId,
      actorRole: resolvedRole,
    };
  }

  /**
   * POST /mapping-versions/{versionId}/ai-suggestions
   */
  @Post('mapping-versions/:versionId/ai-suggestions')
  @HttpCode(HttpStatus.OK)
  public async getMappingSuggestions(
    @Param('versionId') versionId: string,
    @Body()
    body: {
      sourceSnapshotId: string;
      targetSnapshotId: string;
      sourceObject: string;
      destinationObject: string;
    },
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const result = await this.aiService.suggestMappings(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        sourceSnapshotId: body.sourceSnapshotId || 'snapshot-source',
        targetSnapshotId: body.targetSnapshotId || 'snapshot-target',
        sourceObject: body.sourceObject || 'customers',
        destinationObject: body.destinationObject || 'customers',
      },
      context
    );

    return {
      data: result.proposal,
      meta: {
        status: result.status,
        mappingVersionId: versionId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * POST /plan-versions/{versionId}/ai-plan
   */
  @Post('plan-versions/:versionId/ai-plan')
  @HttpCode(HttpStatus.OK)
  public async draftPlan(
    @Param('versionId') versionId: string,
    @Body()
    body: {
      userObjective: string;
      sourceConnectionId: string;
      targetConnectionId: string;
      sourceSnapshotId?: string;
      targetSnapshotId?: string;
    },
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const result = await this.aiService.draftPlan(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        userObjective: body.userObjective || 'Migrate MongoDB to PostgreSQL',
        sourceConnectionId: body.sourceConnectionId || 'conn-source',
        targetConnectionId: body.targetConnectionId || 'conn-target',
        sourceSnapshotId: body.sourceSnapshotId,
        targetSnapshotId: body.targetSnapshotId,
      },
      context
    );

    return {
      data: result.proposal,
      meta: {
        status: result.status,
        planVersionId: versionId,
        unresolvedQuestions: result.unresolvedQuestions,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * POST /validation-runs/{validationRunId}/ai-analysis
   */
  @Post('validation-runs/:validationRunId/ai-analysis')
  @HttpCode(HttpStatus.OK)
  public async analyzeDiscrepancies(
    @Param('validationRunId') validationRunId: string,
    @Body() body: { category?: string },
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const result = await this.aiService.analyzeDiscrepancies(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        validationRunId,
        categoryFilter: body?.category,
      },
      context
    );

    return {
      data: result.investigation,
      meta: {
        validationRunId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * POST /projects/{projectId}/ai/conversations
   */
  @Post('projects/:projectId/ai/conversations')
  @HttpCode(HttpStatus.CREATED)
  public async createConversation(
    @Param('projectId') projectId: string,
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const conversationId = `conv-${Date.now()}`;
    return {
      data: {
        conversationId,
        projectId,
        workspaceId: context.workspaceId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * POST /ai/conversations/{conversationId}/messages
   */
  @Post('ai/conversations/:conversationId/messages')
  @HttpCode(HttpStatus.OK)
  public async askCopilot(
    @Param('conversationId') conversationId: string,
    @Body()
    body: {
      message: string;
      runId?: string;
      validationRunId?: string;
    },
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const result = await this.aiService.askCopilot(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        userMessage: body.message || 'Summarize the current migration status',
        conversationId,
        runId: body.runId,
        validationRunId: body.validationRunId,
      },
      context
    );

    return {
      data: result.response,
      meta: {
        conversationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * GET /ai/conversations/{conversationId}
   */
  @Get('ai/conversations/:conversationId')
  public async getConversation(@Param('conversationId') conversationId: string) {
    return {
      data: {
        conversationId,
        status: 'ACTIVE',
        history: [],
      },
    };
  }

  /**
   * GET /ai/workflows/{workflowId}
   */
  @Get('ai/workflows/:workflowId')
  public async getWorkflowTrace(@Param('workflowId') workflowId: string) {
    const trace = await this.aiService.getWorkflowTrace(workflowId);
    return {
      data: trace || {
        traceId: workflowId,
        status: 'NOT_FOUND',
      },
    };
  }

  /**
   * POST /ai/proposals/{proposalId}/accept
   */
  @Post('ai/proposals/:proposalId/accept')
  @HttpCode(HttpStatus.OK)
  public async acceptProposal(
    @Param('proposalId') proposalId: string,
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const data = await this.aiService.acceptProposal(proposalId, context.actorId);
    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
       VALUES ($1, $2, 'USER', $3, 'AI_PROPOSAL_ACCEPTED', 'AI_PROPOSAL', $4, $5)`,
      [context.workspaceId, context.projectId === 'default-project' ? null : context.projectId, context.actorId, proposalId, { proposalId, decision: 'ACCEPT' }],
    );
    return { data };
  }

  /**
   * POST /ai/proposals/:proposalId/reject
   */
  @Post('ai/proposals/:proposalId/reject')
  @HttpCode(HttpStatus.OK)
  public async rejectProposal(
    @Param('proposalId') proposalId: string,
    @Req() req: any
  ) {
    const context = await this.extractContext(req);
    const data = await this.aiService.rejectProposal(proposalId, context.actorId);
    await this.db.query(
      `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
       VALUES ($1, $2, 'USER', $3, 'AI_PROPOSAL_REJECTED', 'AI_PROPOSAL', $4, $5)`,
      [context.workspaceId, context.projectId === 'default-project' ? null : context.projectId, context.actorId, proposalId, { proposalId, decision: 'REJECT' }],
    );
    return { data };
  }
}
