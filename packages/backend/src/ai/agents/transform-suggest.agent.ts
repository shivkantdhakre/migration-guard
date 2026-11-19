import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  TransformSuggestion,
  TransformSuggestionSchema,
} from '../schemas/transform-suggest.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { AiTraceService } from '../trace.service.js';

export interface TransformSuggestState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  sourcePath: string;
  destinationPath: string;
  targetType: string;
  sampleValue?: unknown;
  suggestion?: TransformSuggestion;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class TransformSuggestAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      sourcePath: string;
      destinationPath: string;
      targetType: string;
      sampleValue?: unknown;
    },
    context: ToolExecutionContext
  ): Promise<TransformSuggestState> {
    const traceId = `trace-transform-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<TransformSuggestState>();

    // Node 1: generate_suggestion
    graph.addNode('generate_suggestion', async (state) => {
      const prompt = `
Recommend an allowlisted transform operation for the following conversion:
Source Field: ${state.sourcePath}
Destination Field: ${state.destinationPath}
Target Type: ${state.targetType}
Sample Value: ${JSON.stringify(state.sampleValue)}

Allowed operations: RENAME, TRIM_STRING, LOWERCASE, UPPERCASE, PARSE_INTEGER, PARSE_DECIMAL, PARSE_TIMESTAMP, TO_JSONB, FLATTEN_OBJECT, SET_DEFAULT, NULL_IF_EMPTY, PRESERVE_SOURCE_ID.
Output strict JSON conforming to transform-suggestion.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        TransformSuggestionSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Transformation Assistant. Suggest safe, allowlisted deterministic transformations.',
          schemaVersion: 'transform-suggestion.v1',
        }
      );

      return {
        suggestion: response.parsed as TransformSuggestion,
      };
    });

    // Node 2: preview_simulation
    graph.addNode('preview_simulation', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'preview_transform',
        input: {
          sampleRecord: { [state.sourcePath]: state.sampleValue ?? ' sample ' },
        },
        context,
      });

      const toolTrace: ToolCallTrace = {
        toolName: 'preview_transform',
        input: { sampleRecord: { [state.sourcePath]: 'sample' } },
        outputSummary: 'Tested transform preview simulation',
        durationMs: Date.now() - toolStart,
        status: toolRes.success ? 'SUCCESS' : 'ERROR',
      };

      return {
        status: 'COMPLETED',
        toolTraces: [...state.toolTraces, toolTrace],
      };
    });

    graph.setEntryPoint('generate_suggestion');
    graph.addEdge('generate_suggestion', 'preview_simulation');
    graph.addEdge('preview_simulation', END);

    const compiled = graph.compile();

    const initialState: TransformSuggestState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
      targetType: input.targetType,
      sampleValue: input.sampleValue,
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'TransformSuggestAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'transform.v1',
      graphVersion: 'transform-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
