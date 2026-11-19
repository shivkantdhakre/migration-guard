import { AiProviderAdapter } from './providers/ai-provider.interface.js';
import { AiProviderFactory } from './providers/provider-factory.js';
import { AiTraceService } from './trace.service.js';
import {
  MigrationPlannerAgent,
  SchemaMappingAgent,
  TransformSuggestAgent,
  RiskAssessmentAgent,
  FailureInvestigatorAgent,
  DiscrepancyInvestigatorAgent,
  RepairPlannerAgent,
  MigrationCopilotAgent,
} from './agents/index.js';
import { ToolExecutionContext } from './types.js';

export class AiService {
  private provider: AiProviderAdapter;
  private traceService: AiTraceService;

  public plannerAgent: MigrationPlannerAgent;
  public schemaMappingAgent: SchemaMappingAgent;
  public transformSuggestAgent: TransformSuggestAgent;
  public riskAssessmentAgent: RiskAssessmentAgent;
  public failureInvestigatorAgent: FailureInvestigatorAgent;
  public discrepancyInvestigatorAgent: DiscrepancyInvestigatorAgent;
  public repairPlannerAgent: RepairPlannerAgent;
  public copilotAgent: MigrationCopilotAgent;

  private acceptedProposals: Map<string, any> = new Map();
  private rejectedProposals: Set<string> = new Set();

  constructor(
    customProvider?: AiProviderAdapter,
    customTraceService?: AiTraceService
  ) {
    this.provider = customProvider || AiProviderFactory.getProvider();
    this.traceService = customTraceService || AiTraceService.getInstance();

    this.plannerAgent = new MigrationPlannerAgent(this.provider, this.traceService);
    this.schemaMappingAgent = new SchemaMappingAgent(this.provider, this.traceService);
    this.transformSuggestAgent = new TransformSuggestAgent(this.provider, this.traceService);
    this.riskAssessmentAgent = new RiskAssessmentAgent(this.provider, this.traceService);
    this.failureInvestigatorAgent = new FailureInvestigatorAgent(this.provider, this.traceService);
    this.discrepancyInvestigatorAgent = new DiscrepancyInvestigatorAgent(this.provider, this.traceService);
    this.repairPlannerAgent = new RepairPlannerAgent(this.provider, this.traceService);
    this.copilotAgent = new MigrationCopilotAgent(this.provider, this.traceService);
  }

  /**
   * Check if AI capabilities are available and enabled (FR-AI-007).
   */
  public isAiEnabled(): boolean {
    return process.env.AI_ENABLED !== 'false' && this.provider.isAvailable();
  }

  /**
   * Propose field mappings for a schema mapping version.
   */
  public async suggestMappings(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      sourceSnapshotId: string;
      targetSnapshotId: string;
      sourceObject: string;
      destinationObject: string;
    },
    context: ToolExecutionContext
  ) {
    return this.schemaMappingAgent.run(input, context);
  }

  /**
   * Draft a migration plan from natural language requirements.
   */
  public async draftPlan(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      userObjective: string;
      sourceConnectionId: string;
      targetConnectionId: string;
      sourceSnapshotId?: string;
      targetSnapshotId?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.plannerAgent.run(input, context);
  }

  /**
   * Cluster validation discrepancies and identify root causes.
   */
  public async analyzeDiscrepancies(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      validationRunId: string;
      categoryFilter?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.discrepancyInvestigatorAgent.run(input, context);
  }

  /**
   * Investigate failed migration batches.
   */
  public async investigateFailure(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      runId: string;
      batchId?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.failureInvestigatorAgent.run(input, context);
  }

  /**
   * Assess technical migration risks.
   */
  public async assessRisk(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      planVersionId: string;
      sourceSnapshotId?: string;
      targetSnapshotId?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.riskAssessmentAgent.run(input, context);
  }

  /**
   * Plan bounded repair action.
   */
  public async planRepair(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      validationRunId?: string;
      discrepancyIds?: string[];
      batchId?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.repairPlannerAgent.run(input, context);
  }

  /**
   * Copilot conversational Q&A citing internal evidence.
   */
  public async askCopilot(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      userMessage: string;
      conversationId?: string;
      runId?: string;
      validationRunId?: string;
    },
    context: ToolExecutionContext
  ) {
    return this.copilotAgent.run(input, context);
  }

  /**
   * Accept an AI proposal into a new draft version (FR-AI-001, 06_API_SPEC.md).
   * Note: Does NOT mutate approved plans in place.
   */
  public async acceptProposal(proposalId: string, actorId: string): Promise<any> {
    const draftVersionId = `draft-v-${Date.now()}`;
    const result = {
      proposalId,
      acceptedBy: actorId,
      draftVersionId,
      status: 'ACCEPTED_INTO_DRAFT',
      acceptedAt: new Date().toISOString(),
    };
    this.acceptedProposals.set(proposalId, result);
    return result;
  }

  /**
   * Reject an AI proposal.
   */
  public async rejectProposal(proposalId: string, actorId: string): Promise<any> {
    this.rejectedProposals.add(proposalId);
    return {
      proposalId,
      rejectedBy: actorId,
      status: 'REJECTED',
      rejectedAt: new Date().toISOString(),
    };
  }

  /**
   * Retrieve trace summary for an AI workflow.
   */
  public async getWorkflowTrace(traceId: string) {
    return this.traceService.getTrace(traceId);
  }
}
