import { AiTraceRecord, ToolCallTrace } from './types.js';

export class AiTraceService {
  private static instance: AiTraceService;
  private traces: Map<string, AiTraceRecord> = new Map();

  public static getInstance(): AiTraceService {
    if (!this.instance) {
      this.instance = new AiTraceService();
    }
    return this.instance;
  }

  /**
   * Persist an AI trace record (FR-AI-006).
   */
  public async recordTrace(trace: AiTraceRecord): Promise<void> {
    this.traces.set(trace.traceId, { ...trace });
  }

  /**
   * Fetch an AI trace record by ID.
   */
  public async getTrace(traceId: string): Promise<AiTraceRecord | null> {
    return this.traces.get(traceId) || null;
  }

  /**
   * List AI traces with optional filters.
   */
  public async listTraces(filter: {
    workspaceId?: string;
    projectId?: string;
    agentName?: string;
    limit?: number;
  } = {}): Promise<AiTraceRecord[]> {
    let result = Array.from(this.traces.values());

    if (filter.workspaceId) {
      result = result.filter((t) => t.workspaceId === filter.workspaceId);
    }
    if (filter.projectId) {
      result = result.filter((t) => t.projectId === filter.projectId);
    }
    if (filter.agentName) {
      result = result.filter((t) => t.agentName === filter.agentName);
    }

    // Sort newest first
    result.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (filter.limit) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }

  /**
   * Clear traces (useful for tests).
   */
  public clear(): void {
    this.traces.clear();
  }
}
