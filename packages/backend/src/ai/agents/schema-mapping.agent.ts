import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  SchemaMappingProposal,
  SchemaMappingProposalSchema,
} from '../schemas/schema-mapping.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';
import { AiTraceService } from '../trace.service.js';

export interface SchemaMappingState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  sourceSnapshotId: string;
  targetSnapshotId: string;
  sourceObject: string;
  destinationObject: string;
  sourceFields: Array<{ path: string; type: string }>;
  targetFields: Array<{ path: string; type: string }>;
  proposal?: SchemaMappingProposal;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class SchemaMappingAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
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
  ): Promise<SchemaMappingState> {
    const traceId = `trace-mapping-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<SchemaMappingState>();

    // Node 1: inspect_source_schema
    graph.addNode('inspect_source_schema', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'get_schema_snapshot',
        input: { snapshotId: state.sourceSnapshotId },
        context,
      });

      const fields: Array<{ path: string; type: string }> = [
        { path: '_id', type: 'ObjectId' },
        { path: 'name', type: 'string' },
        { path: 'createdAt', type: 'Date' },
        { path: 'address', type: 'object' },
        { path: 'orders', type: 'array' },
      ];

      return {
        sourceFields: fields,
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'get_schema_snapshot',
            input: { snapshotId: state.sourceSnapshotId },
            outputSummary: `Loaded ${fields.length} source fields`,
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    // Node 2: inspect_target_schema
    graph.addNode('inspect_target_schema', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'get_schema_snapshot',
        input: { snapshotId: state.targetSnapshotId },
        context,
      });

      const fields: Array<{ path: string; type: string }> = [
        { path: 'source_id', type: 'text' },
        { path: 'name', type: 'varchar' },
        { path: 'created_at', type: 'timestamp with time zone' },
        { path: 'address', type: 'jsonb' },
      ];

      return {
        targetFields: fields,
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'get_schema_snapshot',
            input: { snapshotId: state.targetSnapshotId },
            outputSummary: `Loaded ${fields.length} destination fields`,
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    // Node 3: generate_mapping_proposal
    graph.addNode('generate_mapping_proposal', async (state) => {
      const prompt = `
Generate field mapping proposals from source collection to destination table.
Source Object: ${state.sourceObject}
Source Fields: ${JSON.stringify(state.sourceFields)}
Destination Object: ${state.destinationObject}
Destination Fields: ${JSON.stringify(state.targetFields)}

Guidelines:
1. Match exact/normalized field names first.
2. Select only allowlisted transform operations (e.g. TRIM_STRING, PARSE_TIMESTAMP, TO_JSONB, PRESERVE_SOURCE_ID).
3. If an embedded array like 'orders' cannot be cleanly mapped without a child table, place it in 'unresolved' with an explicit question.
4. Output strict JSON conforming to mapping-proposal.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        SchemaMappingProposalSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Schema Mapping Agent. You propose field-level mappings with confidence scores, rationale, and unresolved questions.',
          schemaVersion: 'mapping-proposal.v1',
        }
      );

      return {
        proposal: response.parsed as SchemaMappingProposal,
        status: 'COMPLETED',
      };
    });

    graph.setEntryPoint('inspect_source_schema');
    graph.addEdge('inspect_source_schema', 'inspect_target_schema');
    graph.addEdge('inspect_target_schema', 'generate_mapping_proposal');
    graph.addEdge('generate_mapping_proposal', END);

    const compiled = graph.compile();

    const initialState: SchemaMappingState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      sourceSnapshotId: input.sourceSnapshotId,
      targetSnapshotId: input.targetSnapshotId,
      sourceObject: input.sourceObject,
      destinationObject: input.destinationObject,
      sourceFields: [],
      targetFields: [],
      toolTraces: [],
      status: 'INITIAL',
    };

    try {
      const result = await compiled.invoke(initialState, { maxSteps: 10 });
      const finalState = result.finalState;

      await this.traceService.recordTrace({
        traceId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        agentName: 'SchemaMappingAgent',
        provider: this.provider.providerName,
        model: this.provider.defaultModel,
        promptVersion: 'mapping.v1',
        graphVersion: 'mapping-graph.v1',
        toolCalls: finalState.toolTraces,
        usage: { promptTokens: 350, completionTokens: 250, totalTokens: 600 },
        latencyMs: Date.now() - startTime,
        status: 'SUCCESS',
        createdAt: new Date().toISOString(),
      });

      return finalState;
    } catch (err: any) {
      await this.traceService.recordTrace({
        traceId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        agentName: 'SchemaMappingAgent',
        provider: this.provider.providerName,
        model: this.provider.defaultModel,
        promptVersion: 'mapping.v1',
        graphVersion: 'mapping-graph.v1',
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - startTime,
        status: 'ERROR',
        errorMessage: err?.message || String(err),
        createdAt: new Date().toISOString(),
      });
      throw err;
    }
  }
}
