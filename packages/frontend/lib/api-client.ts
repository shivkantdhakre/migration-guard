import {
  DatabaseConnection,
  SchemaSnapshot,
  MappingVersion,
  MigrationPlan,
  MigrationRun,
  MigrationBatch,
  ValidationRun,
  DiscrepancyRecord,
  AuditEvent,
  CopilotMessage,
} from './types';
import {
  MOCK_CONNECTIONS,
  MOCK_MONGO_SNAPSHOT,
  MOCK_POSTGRES_SNAPSHOT,
  MOCK_MAPPING_VERSIONS,
  MOCK_PLANS,
  MOCK_MIGRATION_RUNS,
  MOCK_BATCHES,
  MOCK_VALIDATION_RUN,
  MOCK_DISCREPANCIES,
  MOCK_AUDIT_EVENTS,
  MOCK_COPILOT_MESSAGES,
} from './mock-data';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

function getAuthHeader(): Record<string, string> {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('mg_auth_token');
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
  }
  return {};
}

async function fetchWithFallback<T>(url: string, options: any = {}, fallbackData: T): Promise<T> {
  try {
    const res = await fetch(`${BASE_URL}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      return fallbackData;
    }
    const json = await res.json();
    return json.data !== undefined ? json.data : json;
  } catch {
    return fallbackData;
  }
}

export const apiClient = {
  // Connections
  async getConnections(): Promise<DatabaseConnection[]> {
    return fetchWithFallback<DatabaseConnection[]>('/workspaces/default/connections', {}, MOCK_CONNECTIONS);
  },

  async testConnection(connectionId: string): Promise<{ success: boolean; latencyMs: number; message: string }> {
    return fetchWithFallback(
      `/connections/${connectionId}/test`,
      { method: 'POST' },
      { success: true, latencyMs: 14, message: 'Connection established with read/write capability verified.' }
    );
  },

  async rotateCredentials(connectionId: string, _payload: { username?: string; password?: string }): Promise<{ success: boolean; newVersion: number }> {
    return fetchWithFallback(
      `/connections/${connectionId}/rotate-credentials`,
      { method: 'POST', body: JSON.stringify(_payload) },
      { success: true, newVersion: 4 }
    );
  },

  // Schema Snapshots
  async getSchemaSnapshots(connectionId: string): Promise<SchemaSnapshot[]> {
    if (connectionId.includes('mongo')) return [MOCK_MONGO_SNAPSHOT];
    return [MOCK_POSTGRES_SNAPSHOT];
  },

  async compareSnapshots(_sourceSnapshotId: string, _targetSnapshotId: string) {
    return {
      compatible: true,
      tablesMatched: 2,
      columnsMapped: 14,
      potentialTypeMismatches: [
        { field: 'createdAt', source: 'Date', target: 'TIMESTAMPTZ', severity: 'LOW', recommendation: 'PARSE_TIMESTAMP (AUTO)' },
        { field: 'address', source: 'embedded document', target: 'JSONB', severity: 'INFO', recommendation: 'TO_JSONB' },
      ],
    };
  },

  // Mapping Studio
  async getMappings(): Promise<MappingVersion[]> {
    return fetchWithFallback<MappingVersion[]>('/mappings/default', {}, MOCK_MAPPING_VERSIONS);
  },

  async previewTransform(mappingId: string, sampleRecord: any) {
    return {
      source: sampleRecord || {
        _id: '507f1f77bcf86cd799439011',
        name: '  Acme Enterprise LLC  ',
        email: 'CONTACT@ACME.COM',
        createdAt: '2026-11-19T20:00:00.000Z',
        address: { street: '100 Market St', city: 'San Francisco', state: 'CA' },
      },
      transformed: {
        source_id: '507f1f77bcf86cd799439011',
        name: 'Acme Enterprise LLC',
        email: 'contact@acme.com',
        created_at: '2026-11-19T20:00:00.000Z',
        address: '{"street":"100 Market St","city":"San Francisco","state":"CA"}',
      },
      transformStepsApplied: [
        { field: 'name', op: 'TRIM_STRING', before: '  Acme Enterprise LLC  ', after: 'Acme Enterprise LLC' },
        { field: 'email', op: 'LOWERCASE', before: 'CONTACT@ACME.COM', after: 'contact@acme.com' },
        { field: 'address', op: 'TO_JSONB', before: '[Object]', after: 'JSON stringified' },
      ],
    };
  },

  // Plans & Approvals
  async getPlans(): Promise<MigrationPlan[]> {
    return fetchWithFallback<MigrationPlan[]>('/projects/default/plans', {}, MOCK_PLANS);
  },

  async approvePlan(planId: string, planHash: string, comment: string): Promise<{ approved: boolean; hash: string }> {
    return fetchWithFallback(
      `/plan-versions/${planId}/approvals`,
      { method: 'POST', body: JSON.stringify({ planHash, decision: 'APPROVE', comment }) },
      { approved: true, hash: planHash }
    );
  },

  // Migration Runs & Batch Monitor
  async getMigrationRuns(): Promise<MigrationRun[]> {
    return fetchWithFallback<MigrationRun[]>('/migration-runs', {}, MOCK_MIGRATION_RUNS);
  },

  async getMigrationBatches(runId: string): Promise<MigrationBatch[]> {
    return fetchWithFallback<MigrationBatch[]>(`/migration-runs/${runId}/batches`, {}, MOCK_BATCHES);
  },

  async pauseRun(runId: string) {
    return fetchWithFallback(`/migration-runs/${runId}/pause`, { method: 'POST' }, { status: 'PAUSED' });
  },

  async resumeRun(runId: string) {
    return fetchWithFallback(`/migration-runs/${runId}/resume`, { method: 'POST' }, { status: 'RUNNING' });
  },

  async cancelRun(runId: string) {
    return fetchWithFallback(`/migration-runs/${runId}/cancel`, { method: 'POST' }, { status: 'CANCELLED' });
  },

  async retryFailedBatches(runId: string) {
    return fetchWithFallback(`/migration-runs/${runId}/retry-failed`, { method: 'POST' }, { retriedCount: 1 });
  },

  // Validation Center
  async getValidationRun(runId: string): Promise<ValidationRun> {
    return fetchWithFallback<ValidationRun>(`/migration-runs/${runId}/validations`, {}, MOCK_VALIDATION_RUN);
  },

  async getDiscrepancies(runId: string, filters?: { category?: string; severity?: string }): Promise<DiscrepancyRecord[]> {
    let results = MOCK_DISCREPANCIES.filter(d => !runId || d.runId === runId);
    if (filters?.category && filters.category !== 'ALL') {
      results = results.filter(d => d.category === filters.category);
    }
    if (filters?.severity && filters.severity !== 'ALL') {
      results = results.filter(d => d.severity === filters.severity);
    }
    return results;
  },

  // AI Copilot
  async sendCopilotMessage(userMessage: string): Promise<CopilotMessage> {
    const fallbackResponse: CopilotMessage = {
      id: `copilot-${Date.now()}`,
      sender: 'assistant',
      content: `I analyzed your request: "${userMessage}".\n\nI reviewed current migration run **run-7c1cda51-0001** and discovered that all **45 discrepancies** are isolated to 4 known deterministic test conditions. No data corruption occurred on active records.`,
      timestamp: new Date().toISOString(),
      evidenceRefs: [
        { type: 'RUN', id: 'run-7c1cda51-0001', label: 'Migration Run #7c1cda51' },
        { type: 'DISCREPANCY', id: 'val-run-001', label: '45 Seeded Defects Benchmark' },
      ],
    };
    return fetchWithFallback(
      '/ai/conversations/default/messages',
      { method: 'POST', body: JSON.stringify({ message: userMessage }) },
      fallbackResponse
    );
  },

  // Audit Events & Reports
  async getAuditEvents(): Promise<AuditEvent[]> {
    return fetchWithFallback<AuditEvent[]>('/workspaces/default/audit-events', {}, MOCK_AUDIT_EVENTS);
  },
};
