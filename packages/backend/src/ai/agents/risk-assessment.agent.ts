import { StateGraph, START, END } from '../graph/state-graph.js';
import {
  RiskAssessment,
  RiskAssessmentSchema,
} from '../schemas/risk-assessment.schema.js';
import { ToolExecutionContext, ToolCallTrace } from '../types.js';
import { ToolCatalog } from '../tools/tool-catalog.js';
import { AiProviderAdapter } from '../providers/ai-provider.interface.js';
import { AiTraceService } from '../trace.service.js';

export interface RiskAssessmentState {
  workspaceId: string;
  projectId: string;
  actorId: string;
  planVersionId: string;
  sourceSnapshotId?: string;
  targetSnapshotId?: string;
  assessment?: RiskAssessment;
  toolTraces: ToolCallTrace[];
  status: 'INITIAL' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

export class RiskAssessmentAgent {
  constructor(
    private provider: AiProviderAdapter,
    private traceService: AiTraceService = AiTraceService.getInstance()
  ) {}

  public async run(
    input: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      planVersionId: string;
      sourceSnapshotId?: string;
      targetSnapshotId?: string;
    },
    context: ToolExecutionContext
  ): Promise<RiskAssessmentState> {
    const traceId = `trace-risk-${Date.now()}`;
    const startTime = Date.now();

    const graph = new StateGraph<RiskAssessmentState>();

    // Node 1: load_profile_and_metadata
    graph.addNode('load_profile_and_metadata', async (state) => {
      const toolStart = Date.now();
      const toolRes = await ToolCatalog.executeTool({
        toolName: 'get_profile_summary',
        input: { snapshotId: state.sourceSnapshotId || 'snapshot-01' },
        context,
      });

      return {
        toolTraces: [
          ...state.toolTraces,
          {
            toolName: 'get_profile_summary',
            input: { snapshotId: state.sourceSnapshotId || 'snapshot-01' },
            outputSummary: 'Loaded profiling summary (null counts and distributions)',
            durationMs: Date.now() - toolStart,
            status: toolRes.success ? 'SUCCESS' : 'ERROR',
          },
        ],
      };
    });

    // Node 2: evaluate_risks
    graph.addNode('evaluate_risks', async (state) => {
      const prompt = `
Perform migration readiness and risk analysis.
Plan Version ID: ${state.planVersionId}
Source Snapshot ID: ${state.sourceSnapshotId}
Target Snapshot ID: ${state.targetSnapshotId}

Analyze risks across categories:
- LOSSY_TRANSFORM
- INCOMPATIBLE_TYPE
- MISSING_CONSTRAINT
- VOLUME_SCALE
- REFERENTIAL_INTEGRITY
- UNMAPPED_REQUIRED_FIELD

Distinguish measured facts from AI hypotheses.
Output strict JSON conforming to risk-assessment.v1 schema.
`.trim();

      const response = await this.provider.generateStructured(
        RiskAssessmentSchema,
        {
          prompt,
          systemPrompt:
            'You are MigrationGuard Risk Assessment Agent. Identify technical migration risks, distinguish measured facts from hypotheses, and recommend mitigations.',
          schemaVersion: 'risk-assessment.v1',
        }
      );

      return {
        assessment: response.parsed as RiskAssessment,
        status: 'COMPLETED',
      };
    });

    graph.setEntryPoint('load_profile_and_metadata');
    graph.addEdge('load_profile_and_metadata', 'evaluate_risks');
    graph.addEdge('evaluate_risks', END);

    const compiled = graph.compile();

    const initialState: RiskAssessmentState = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorId: input.actorId,
      planVersionId: input.planVersionId,
      sourceSnapshotId: input.sourceSnapshotId,
      targetSnapshotId: input.targetSnapshotId,
      toolTraces: [],
      status: 'INITIAL',
    };

    const result = await compiled.invoke(initialState);
    const finalState = result.finalState;

    await this.traceService.recordTrace({
      traceId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentName: 'RiskAssessmentAgent',
      provider: this.provider.providerName,
      model: this.provider.defaultModel,
      promptVersion: 'risk.v1',
      graphVersion: 'risk-graph.v1',
      toolCalls: finalState.toolTraces,
      usage: { promptTokens: 300, completionTokens: 250, totalTokens: 550 },
      latencyMs: Date.now() - startTime,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    return finalState;
  }
}
