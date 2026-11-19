import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  RepairProposal,
  RepairProposalSchema,
} from '../schemas/repair-planner.schema.js';
import {
  ToolExecutionContext,
  ToolCallTrace,
  ALLOWLISTED_REPAIR_OPERATIONS,
  AllowlistedRepairOp,
} from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';
import { AiTraceService } from '../trace.service.js';

export interface RepairPlannerState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  validationRunId?: string;
  discrepancyIds?: string[];
  batchId?: string;
  preferredOperation?: AllowlistedRepairOp;
  proposal?: RepairProposal;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class RepairPlannerAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      validationRunId?: string;
      discrepancyIds?: string[];
      batchId?: string;
      preferredOperation?: AllowlistedRepairOp;
    },
    context: ToolExecutionContext
  ): Promise<RepairPlannerState> {
    const traceId = `trace-repair-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<RepairPlannerState>();

    // Node 1: generate_repair_proposal
    graph.addNode('generate_repair_proposal', async (state) => {
      const prompt = `
Generate a bounded repair proposal for migration issues.
Validation Run ID: ${state.validationRunId || 'N/A'}
Discrepancy IDs: ${JSON.stringify(state.discrepancyIds || [])}
Batch ID: ${state.batchId || 'N/A'}
Preferred Operation: ${state.preferredOperation || 'AUTO'}

SAFETY RULES:
1. Operation MUST be one of: ${ALLOWLISTED_REPAIR_OPERATIONS.join(', ')}.
2. Strictly FORBIDDEN: Arbitrary SQL, shell commands, or unconstrained execution scripts.
3. Proposal requiresDryRun = true and requiresApproval = true.
4. Output strict JSON conforming to repair-proposal.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        RepairProposalSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Repair Planner Agent. You draft bounded, allowlisted repair actions. You never emit arbitrary SQL or shell scripts.',
          schemaVersion: 'repair-proposal.v1',
        }
      );

      // Verify safety against forbidden scripts
      PromptSanitizer.validateSafeOutput(JSON.stringify(response.parsed));

      return {
        proposal: response.parsed as RepairProposal,
      };
    });

    // Node 2: register_draft_proposal
    graph.addNode('register_draft_proposal', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'create_draft_proposal',
        input: {
          proposalType: 'REPAIR',
          content: state.proposal as any,
          rationale: 'AI repair proposal requires human review and dry run',
        },
        context,
      });

      return {
        status: 'COMPLETED',
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'create_draft_proposal',
            input: { proposalType: 'REPAIR' },
            outputSummary: 'Persisted unapproved draft repair proposal',
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    graph.setEntryPoint('generate_repair_proposal');
    graph.addEdge('generate_repair_proposal', 'register_draft_proposal');
    graph.addEdge('register_draft_proposal', END);

    const compiled = graph.compile();

    const initialState: RepairPlannerState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      validationRunId: input.validationRunId,
      discrepancyIds: input.discrepancyIds,
      batchId: input.batchId,
      preferredOperation: input.preferredOperation,
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'RepairPlannerAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'repair.v1',
      graphVersion: 'repair-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
