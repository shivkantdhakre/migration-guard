import { describe, it, expect, beforeEach } from 'vitest';
import { AiTraceService } from '../../src/ai/trace.service.js';
import { AiTraceRecord } from '../../src/ai/types.js';

describe('AI Traces Persistence (FR-AI-006)', () => {
  let traceService: AiTraceService;

  beforeEach(() => {
    traceService = AiTraceService.getInstance();
    traceService.clear();
  });

  it('should persist and retrieve AI trace with all required audit metadata', async () => {
    const traceRecord: AiTraceRecord = {
      traceId: 'trace-test-01',
      workspaceId: 'ws-test-01',
      projectId: 'proj-test-01',
      agentName: 'MigrationPlannerAgent',
      provider: 'mock',
      model: 'mock-deterministic-v1',
      promptVersion: 'planner.v1',
      graphVersion: 'planner-graph.v1',
      toolCalls: [
        {
          toolName: 'get_schema_snapshot',
          input: { snapshotId: 'snap-01' },
          outputSummary: 'Loaded 5 collections',
          durationMs: 45,
          status: 'SUCCESS',
        },
      ],
      usage: {
        promptTokens: 250,
        completionTokens: 200,
        totalTokens: 450,
      },
      latencyMs: 120,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    };

    await traceService.recordTrace(traceRecord);

    const fetched = await traceService.getTrace('trace-test-01');
    expect(fetched).toBeDefined();
    expect(fetched?.agentName).toBe('MigrationPlannerAgent');
    expect(fetched?.model).toBe('mock-deterministic-v1');
    expect(fetched?.promptVersion).toBe('planner.v1');
    expect(fetched?.toolCalls.length).toBe(1);
    expect(fetched?.toolCalls[0].toolName).toBe('get_schema_snapshot');
    expect(fetched?.latencyMs).toBe(120);
  });

  it('should list and filter traces by workspace, project, or agent name', async () => {
    await traceService.recordTrace({
      traceId: 't-1',
      workspaceId: 'ws-A',
      projectId: 'proj-1',
      agentName: 'SchemaMappingAgent',
      provider: 'mock',
      model: 'mock-v1',
      promptVersion: 'v1',
      graphVersion: 'v1',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 50,
      status: 'SUCCESS',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });

    await traceService.recordTrace({
      traceId: 't-2',
      workspaceId: 'ws-A',
      projectId: 'proj-2',
      agentName: 'RiskAssessmentAgent',
      provider: 'mock',
      model: 'mock-v1',
      promptVersion: 'v1',
      graphVersion: 'v1',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 60,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    await traceService.recordTrace({
      traceId: 't-3',
      workspaceId: 'ws-B',
      projectId: 'proj-3',
      agentName: 'MigrationCopilotAgent',
      provider: 'mock',
      model: 'mock-v1',
      promptVersion: 'v1',
      graphVersion: 'v1',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 70,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    });

    const wsATraces = await traceService.listTraces({ workspaceId: 'ws-A' });
    expect(wsATraces.length).toBe(2);

    const copilotTraces = await traceService.listTraces({ agentName: 'MigrationCopilotAgent' });
    expect(copilotTraces.length).toBe(1);
    expect(copilotTraces[0].traceId).toBe('t-3');
  });
});
