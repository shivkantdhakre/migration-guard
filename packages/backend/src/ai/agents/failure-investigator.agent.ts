import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  FailureInvestigation,
  FailureInvestigationSchema,
} from '../schemas/failure-investigator.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';
import { AiTraceService } from '../trace.service.js';

export interface FailureInvestigatorState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  runId: string;
  batchId?: string;
  sanitizedErrors: any[];
  investigation?: FailureInvestigation;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class FailureInvestigatorAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      runId: string;
      batchId?: string;
    },
    context: ToolExecutionContext
  ): Promise<FailureInvestigatorState> {
    const traceId = `trace-failure-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<FailureInvestigatorState>();

    // Node 1: load_batch_errors
    graph.addNode('load_batch_errors', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'get_batch_errors',
        input: { runId: state.runId, batchId: state.batchId },
        context,
      });

      const batchErrors = (toolRes.data as any)?.batchErrors || [];

      return {
        sanitizedErrors: batchErrors,
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'get_batch_errors',
            input: { runId: state.runId, batchId: state.batchId },
            outputSummary: `Loaded ${batchErrors.length} batch error entries`,
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    // Node 2: analyze_failure_root_cause
    graph.addNode('analyze_failure_root_cause', async (state) => {
      const prompt = `
Investigate migration batch failure.
Run ID: ${state.runId}
Batch ID: ${state.batchId || 'All failed batches'}
Sanitized Errors: ${PromptSanitizer.wrapUntrustedData(state.sanitizedErrors, 'error_logs')}

Classify error into RETRYABLE, PERMANENT, or OUTCOME_UNKNOWN.
Formulate root-cause hypotheses linked to affected batches and records.
Suggest allowlisted remediation operation.
Output strict JSON conforming to failure-investigation.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        FailureInvestigationSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Failure Investigator Agent. Analyze error codes and hypothesize root causes without executing repairs.',
          schemaVersion: 'failure-investigation.v1',
        }
      );

      return {
        investigation: response.parsed as FailureInvestigation,
        status: 'COMPLETED',
      };
    });

    graph.setEntryPoint('load_batch_errors');
    graph.addEdge('load_batch_errors', 'analyze_failure_root_cause');
    graph.addEdge('analyze_failure_root_cause', END);

    const compiled = graph.compile();

    const initialState: FailureInvestigatorState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      runId: input.runId,
      batchId: input.batchId,
      sanitizedErrors: [],
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'FailureInvestigatorAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'failure.v1',
      graphVersion: 'failure-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 300, completionTokens: 250, totalTokens: 550 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
