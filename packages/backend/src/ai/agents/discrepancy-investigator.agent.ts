import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  DiscrepancyInvestigation,
  DiscrepancyInvestigationSchema,
} from '../schemas/discrepancy-investigator.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';
import { AiTraceService } from '../trace.service.js';

export interface DiscrepancyInvestigatorState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  validationRunId: string;
  categoryFilter?: string;
  discrepancies: any[];
  investigation?: DiscrepancyInvestigation;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class DiscrepancyInvestigatorAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      validationRunId: string;
      categoryFilter?: string;
    },
    context: ToolExecutionContext
  ): Promise<DiscrepancyInvestigatorState> {
    const traceId = `trace-discrepancy-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<DiscrepancyInvestigatorState>();

    // Node 1: fetch_validation_discrepancies
    graph.addNode('fetch_validation_discrepancies', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'get_discrepancy_evidence',
        input: {
          validationRunId: state.validationRunId,
          category: state.categoryFilter,
          limit: 100,
        },
        context,
      });

      const list = (toolRes.data as any)?.discrepancies || [];

      return {
        discrepancies: list,
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'get_discrepancy_evidence',
            input: { validationRunId: state.validationRunId },
            outputSummary: `Loaded ${list.length} discrepancies for clustering`,
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    // Node 2: cluster_and_hypothesize
    graph.addNode('cluster_and_hypothesize', async (state) => {
      const prompt = `
Analyze validation discrepancies and group them into logical issue clusters.
Validation Run ID: ${state.validationRunId}
Discrepancies: ${PromptSanitizer.wrapUntrustedData(state.discrepancies, 'discrepancy_evidence')}

CRITICAL REQUIREMENTS:
1. Every cluster MUST contain the exact list of affected discrepancy IDs (UUIDs or IDs from the evidence).
2. Group records with identical failure patterns (e.g. missing attachment hashes, duplicate keys, broken references).
3. Any causal explanation not directly proven must have isProvenFact = false (labeled as a hypothesis).
4. Output strict JSON conforming to discrepancy-investigation.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        DiscrepancyInvestigationSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Discrepancy Investigator Agent. You cluster validation issues and link them to exact discrepancy IDs.',
          schemaVersion: 'discrepancy-investigation.v1',
        }
      );

      return {
        investigation: response.parsed as DiscrepancyInvestigation,
        status: 'COMPLETED',
      };
    });

    graph.setEntryPoint('fetch_validation_discrepancies');
    graph.addEdge('fetch_validation_discrepancies', 'cluster_and_hypothesize');
    graph.addEdge('cluster_and_hypothesize', END);

    const compiled = graph.compile();

    const initialState: DiscrepancyInvestigatorState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      validationRunId: input.validationRunId,
      categoryFilter: input.categoryFilter,
      discrepancies: [],
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'DiscrepancyInvestigatorAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'discrepancy.v1',
      graphVersion: 'discrepancy-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 350, completionTokens: 300, totalTokens: 650 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
