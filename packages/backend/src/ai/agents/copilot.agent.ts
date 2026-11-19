import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  CopilotResponse,
  CopilotResponseSchema,
} from '../schemas/copilot.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';
import { AiTraceService } from '../trace.service.js';

export interface CopilotState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  userMessage: string;
  conversationId?: string;
  runId?: string;
  validationRunId?: string;
  contextSummary?: string;
  response?: CopilotResponse;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class MigrationCopilotAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
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
  ): Promise<CopilotState> {
    const traceId = `trace-copilot-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<CopilotState>();

    // Node 1: retrieve_authorized_context
    graph.addNode('retrieve_authorized_context', async (state) => {
      const toolTraces: ToolCallTrace[] = [];
      let summary = 'Context: ';

      // If runId present, fetch run summary
      if (state.runId) {
        const toolStart = Date.now();
        const runRes = await ToolCatalog.executeTool({
          toolName: 'get_run_summary',
          input: { runId: state.runId },
          context,
        });
        toolTraces.push({
          toolName: 'get_run_summary',
          input: { runId: state.runId },
          outputSummary: runRes.success ? 'Fetched run status and progress counters' : 'Run summary error',
          durationMs: Date.now() - toolStart,
          status: runRes.success ? 'SUCCESS' : 'ERROR',
        });
        summary += `Run state: ${JSON.stringify(runRes.data)}. `;
      }

      // If validationRunId present, fetch discrepancy evidence
      if (state.validationRunId) {
        const toolStart = Date.now();
        const discRes = await ToolCatalog.executeTool({
          toolName: 'get_discrepancy_evidence',
          input: { validationRunId: state.validationRunId, limit: 10 },
          context,
        });
        toolTraces.push({
          toolName: 'get_discrepancy_evidence',
          input: { validationRunId: state.validationRunId },
          outputSummary: discRes.success ? 'Fetched validation discrepancy evidence' : 'Discrepancy error',
          durationMs: Date.now() - toolStart,
          status: discRes.success ? 'SUCCESS' : 'ERROR',
        });
        summary += `Validation discrepancies: ${JSON.stringify(discRes.data)}. `;
      }

      return {
        contextSummary: summary,
        toolTraces: [...state.toolTraces, ...toolTraces],
      };
    });

    // Node 2: formulate_grounded_answer
    graph.addNode('formulate_grounded_answer', async (state) => {
      const prompt = `
Answer the user's question regarding the migration platform.
User Question: ${PromptSanitizer.wrapUntrustedData(state.userMessage, 'user_question')}
Available Context: ${state.contextSummary || 'No run context specified'}

EVIDENCE & TRUTHFULNESS REQUIREMENTS:
1. Distinguish measured facts from AI hypotheses.
2. In 'facts', include statements verified by evidence with typed EvidenceRefs (e.g. RUN, DISCREPANCY, SNAPSHOT).
3. In 'hypotheses', label unverified inferences and assign confidence scores.
4. Provide actionable recommendations.
5. Output strict JSON conforming to copilot-response.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        CopilotResponseSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Copilot. Provide grounded, factual answers to user questions citing exact internal evidence.',
          schemaVersion: 'copilot-response.v1',
        }
      );

      return {
        response: response.parsed as CopilotResponse,
        status: 'COMPLETED',
      };
    });

    graph.setEntryPoint('retrieve_authorized_context');
    graph.addEdge('retrieve_authorized_context', 'formulate_grounded_answer');
    graph.addEdge('formulate_grounded_answer', END);

    const compiled = graph.compile();

    const initialState: CopilotState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      userMessage: input.userMessage,
      conversationId: input.conversationId,
      runId: input.runId,
      validationRunId: input.validationRunId,
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'MigrationCopilotAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'copilot.v1',
      graphVersion: 'copilot-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 350, completionTokens: 300, totalTokens: 650 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
