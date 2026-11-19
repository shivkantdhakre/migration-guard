import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AiService } from './ai.service.js';
import { ToolExecutionContext } from './types.js';

@Controller()
export class AiController {
  constructor(private readonly aiService: AiService) {}

  private extractContext(req: any): ToolExecutionContext {
    const user = req?.user || {};
    return {
      workspaceId: req?.headers?.['x-workspace-id'] || user.workspaceId || 'ws-default',
      projectId: req?.headers?.['x-project-id'] || user.projectId || 'proj-default',
      actorId: user.id || 'actor-default',
      actorRole: user.role || 'ENGINEER',
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
    const context = this.extractContext(req);
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
    const context = this.extractContext(req);
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
    const context = this.extractContext(req);
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
    const context = this.extractContext(req);
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
    const context = this.extractContext(req);
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
    const context = this.extractContext(req);
    const data = await this.aiService.acceptProposal(proposalId, context.actorId);
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
    const context = this.extractContext(req);
    const data = await this.aiService.rejectProposal(proposalId, context.actorId);
    return { data };
  }
}
