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
  DryRunResult,
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

export function getAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('mg_auth_token');
  }
  return null;
}

export function setAuthToken(token: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('mg_auth_token', token);
  }
}

export function clearAuthToken(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('mg_auth_token');
  }
}

export function isDemoModeEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const override = localStorage.getItem('mg_demo_mode');
    if (override === 'true') return true;
    if (override === 'false') return false;
  }
  // In production, demo mode is strictly disabled by default unless explicitly set via NEXT_PUBLIC_DEMO_MODE=true
  if (process.env.NODE_ENV === 'production') {
    return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  }
  // In development, demo mode is enabled unless explicitly disabled
  return process.env.NEXT_PUBLIC_DEMO_MODE !== 'false';
}

export function setDemoMode(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('mg_demo_mode', enabled ? 'true' : 'false');
  }
}

let authPromise: Promise<string | null> | null = null;

export async function ensureAuthToken(): Promise<string | null> {
  const existing = getAuthToken();
  if (existing) return existing;

  // In production mode, automatic login is strictly disabled.
  // Production environments MUST authenticate through standard login workflows. No escape hatch.
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  if (typeof window === 'undefined') return null;
  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      // 1. Try logging in as default operator
      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@migrationguard.io',
          password: 'MigrationGuard2026!',
        }),
      });

      if (loginRes.ok) {
        const json = await loginRes.json();
        const token = json?.data?.accessToken || json?.accessToken;
        if (token) {
          setAuthToken(token);
          return token;
        }
      }

      // 2. If not registered, auto-register default operator account
      const regRes = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@migrationguard.io',
          name: 'Lead Operator',
          password: 'MigrationGuard2026!',
        }),
      });

      if (regRes.ok) {
        const json = await regRes.json();
        const token = json?.data?.accessToken || json?.accessToken;
        if (token) {
          setAuthToken(token);
          return token;
        }
      }
    } catch (e: any) {
      console.warn('[MigrationGuard Auth] Automatic operator login notice:', e?.message);
    } finally {
      authPromise = null;
    }
    return null;
  })();

  return authPromise;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  let token = getAuthToken();
  if (!token && typeof window !== 'undefined') {
    token = await ensureAuthToken();
  }
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

function parseErrorMessage(errText: string, status: number, url: string): string {
  let errMsg = `Request to ${url} failed with status ${status}`;
  try {
    const parsed = JSON.parse(errText);
    if (parsed?.error && typeof parsed.error === 'object' && parsed.error.message) {
      errMsg = String(parsed.error.message);
    } else if (typeof parsed?.message === 'string') {
      errMsg = parsed.message;
    } else if (Array.isArray(parsed?.message)) {
      errMsg = parsed.message.join('; ');
    } else if (typeof parsed?.error === 'string') {
      errMsg = parsed.error;
    }
  } catch {
    if (errText && errText.length < 200) {
      errMsg = errText;
    }
  }
  return errMsg;
}

async function request<T>(url: string, options: RequestInit = {}, fallbackData?: T): Promise<T> {
  const fullUrl = `${BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;

  try {
    const authHeaders = await getAuthHeader();
    const res = await fetch(fullUrl, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      const errMsg = parseErrorMessage(errText, res.status, url);

      // In production, fallback to mock data is strictly forbidden unless explicitly in demo mode.
      if (fallbackData !== undefined && isDemoModeEnabled()) {
        console.warn(`[MigrationGuard Demo Mode] Non-OK status ${res.status} for ${url}, using baseline data:`, errMsg);
        return fallbackData;
      }

      throw new Error(errMsg);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      return json.data !== undefined ? json.data : json;
    }
    const text = await res.text();
    return text as unknown as T;
  } catch (err: any) {
    // In production, fallback to mock data is strictly forbidden unless explicitly in demo mode.
    if (fallbackData !== undefined && isDemoModeEnabled()) {
      console.warn(`[MigrationGuard Demo Mode] Network notice for ${url}, using baseline data:`, err?.message || err);
      return fallbackData;
    }
    const message = typeof err?.message === 'string'
      ? err.message
      : (err?.message ? JSON.stringify(err.message) : (typeof err === 'string' ? err : 'Connection failed'));
    throw new Error(`MigrationGuard Backend Error (${url}): ${message}`);
  }
}

function normalizeConnection(raw: any): DatabaseConnection {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    ...raw,
    config: raw.config ?? raw.config_json ?? {},
    credentialVersion: raw.credentialVersion ?? raw.credential_version ?? 1,
    connectionRole: raw.connectionRole ?? raw.connection_role,
    workspaceId: raw.workspaceId ?? raw.workspace_id,
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at,
  };
}

export const apiClient = {
  // Authentication
  async login(email: string, password: string): Promise<{ access_token: string; user: any }> {
    const data = await request<{ access_token: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data?.access_token) {
      setAuthToken(data.access_token);
    }
    return data;
  },

  async register(email: string, name: string, password: string): Promise<{ access_token: string; user: any }> {
    const data = await request<{ access_token: string; user: any }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    });
    if (data?.access_token) {
      setAuthToken(data.access_token);
    }
    return data;
  },

  async getCurrentUser() {
    return request('/me');
  },

  logout() {
    clearAuthToken();
  },

  // Workspaces & Projects
  async getProjects(workspaceId: string): Promise<any[]> {
    return request<any[]>(`/workspaces/${workspaceId}/projects`);
  },

  async createProject(workspaceId: string, name: string, description?: string): Promise<any> {
    return request<any>(`/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  },

  async getProject(projectId: string): Promise<any> {
    return request<any>(`/projects/${projectId}`);
  },

  // Connections
  async getConnections(workspaceId = 'default'): Promise<DatabaseConnection[]> {
    const list = await request<any[]>(
      `/workspaces/${workspaceId}/connections`,
      {},
      MOCK_CONNECTIONS
    );
    return Array.isArray(list) ? list.map(normalizeConnection) : [];
  },

  async createConnection(workspaceId = 'default', payload: any): Promise<DatabaseConnection> {
    const created = await request<any>(`/workspaces/${workspaceId}/connections`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return normalizeConnection(created);
  },

  async testConnection(connectionId: string): Promise<{ success: boolean; latencyMs: number; message: string }> {
    const res = await request<any>(
      `/connections/${connectionId}/test`,
      { method: 'POST' },
      { success: true, latencyMs: 14, message: 'Connection established with read/write capability verified.' }
    );
    const success = Boolean(res?.success ?? res?.reachable ?? res?.status === 'HEALTHY');
    return {
      success,
      latencyMs: Number(res?.latencyMs ?? 0),
      message: String(
        res?.message ??
          res?.error ??
          (success ? `${res?.engineVersion || 'Connected'} verified` : 'Connection probe failed')
      ),
    };
  },

  async rotateCredentials(connectionId: string, payload: { username?: string; password?: string }): Promise<{ success: boolean; newVersion: number }> {
    return request(
      `/connections/${connectionId}/rotate-credentials`,
      { method: 'POST', body: JSON.stringify(payload) },
      { success: true, newVersion: 4 }
    );
  },

  // Schema Discovery & Comparison
  async triggerDiscovery(connectionId: string, options: any = {}) {
    return request(`/connections/${connectionId}/schema-discovery`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  async getSchemaSnapshots(connectionId: string): Promise<SchemaSnapshot[]> {
    return request<SchemaSnapshot[]>(
      `/connections/${connectionId}/schema-snapshots`,
      {},
      connectionId.includes('mongo') ? [MOCK_MONGO_SNAPSHOT] : [MOCK_POSTGRES_SNAPSHOT]
    );
  },

  async compareSnapshots(sourceSnapshotId: string, targetSnapshotId: string) {
    return request(
      '/schema-snapshots/compare',
      {
        method: 'POST',
        body: JSON.stringify({ sourceSnapshotId, targetSnapshotId }),
      },
      {
        compatible: true,
        tablesMatched: 2,
        columnsMapped: 14,
        potentialTypeMismatches: [
          { field: 'createdAt', source: 'Date', target: 'TIMESTAMPTZ', severity: 'LOW', recommendation: 'PARSE_TIMESTAMP (AUTO)' },
          { field: 'address', source: 'embedded document', target: 'JSONB', severity: 'INFO', recommendation: 'TO_JSONB' },
        ],
      }
    );
  },

  // Mapping Studio
  async getMappings(projectId = 'default'): Promise<MappingVersion[]> {
    return request<MappingVersion[]>(`/projects/${projectId}/mappings`, {}, MOCK_MAPPING_VERSIONS);
  },

  async getWorkspaceMappings(workspaceId = 'default'): Promise<MappingVersion[]> {
    return request<MappingVersion[]>(`/workspaces/${workspaceId}/mappings`, {}, MOCK_MAPPING_VERSIONS);
  },

  async getPlanMappings(planId: string): Promise<MappingVersion[]> {
    return request<MappingVersion[]>(`/plans/${planId}/mappings`, {}, MOCK_MAPPING_VERSIONS);
  },

  async createMappingProfile(projectId: string, planId: string): Promise<MappingVersion> {
    return request<MappingVersion>(`/projects/${projectId}/mappings`, {
      method: 'POST',
      body: JSON.stringify({ planId }),
    });
  },

  async createMappingVersion(planId: string, mappingJson: any): Promise<MappingVersion> {
    return request<MappingVersion>(`/mappings/${planId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ mappingJson }),
    });
  },

  async getMappingVersion(versionId: string): Promise<MappingVersion> {
    return request<MappingVersion>(`/mapping-versions/${versionId}`);
  },

  async validateMapping(versionId: string): Promise<{ valid: boolean; issues: any[] }> {
    return request(`/mapping-versions/${versionId}/validate`, {
      method: 'POST',
    });
  },

  async previewTransform(mappingId: string, sampleRecord: any) {
    return request(
      `/mapping-versions/${mappingId}/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ sampleRecords: sampleRecord ? [sampleRecord] : [] }),
      },
      {
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
      }
    );
  },

  async getAiMappingSuggestions(versionId: string, payload: any) {
    return request(`/mapping-versions/${versionId}/ai-suggestions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Plans, Dry-Runs & Approvals
  async getPlans(projectId = 'default'): Promise<MigrationPlan[]> {
    return request<MigrationPlan[]>(`/projects/${projectId}/plans`, {}, MOCK_PLANS);
  },

  async createPlan(projectId = 'default', name: string): Promise<MigrationPlan> {
    return request<MigrationPlan>(`/projects/${projectId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  async getPlan(planId: string): Promise<MigrationPlan> {
    return request<MigrationPlan>(`/plans/${planId}`);
  },

  async createPlanVersion(planId: string, versionData: any): Promise<any> {
    return request(`/plans/${planId}/versions`, {
      method: 'POST',
      body: JSON.stringify(versionData),
    });
  },

  async getPlanVersion(versionId: string): Promise<any> {
    return request(`/plan-versions/${versionId}`);
  },

  async startDryRun(versionId: string): Promise<DryRunResult> {
    if (!versionId || typeof versionId !== 'string' || versionId.trim() === '') {
      throw new Error('Cannot execute dry run: plan versionId is required and must not be empty.');
    }
    // Strict dry-run: never supply fallbackData. This guarantees that 404, 500, network errors,
    // or unauthenticated requests always throw rather than returning fake success data.
    return request<DryRunResult>(`/plan-versions/${versionId.trim()}/dry-runs`, {
      method: 'POST',
    });
  },

  async getDryRun(dryRunId: string): Promise<DryRunResult> {
    if (!dryRunId || typeof dryRunId !== 'string' || dryRunId.trim() === '') {
      throw new Error('Cannot fetch dry run details: dryRunId is required.');
    }
    return request<DryRunResult>(`/dry-runs/${dryRunId.trim()}`);
  },

  async approvePlan(planVersionId: string, planHash: string, comment: string): Promise<{ approved: boolean; hash: string }> {
    if (!planVersionId || typeof planVersionId !== 'string' || planVersionId.trim() === '') {
      throw new Error('Cannot approve plan: planVersionId is required and must not be empty.');
    }
    return request(
      `/plan-versions/${planVersionId.trim()}/approvals`,
      { method: 'POST', body: JSON.stringify({ planHash, decision: 'APPROVE', comment }) },
      isDemoModeEnabled() ? { approved: true, hash: planHash } : undefined
    );
  },

  async draftAiPlan(planVersionId: string, payload: any) {
    return request(`/plan-versions/${planVersionId}/ai-plan`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Migration Runs & Batch Monitor
  async getMigrationRuns(workspaceId = 'default'): Promise<MigrationRun[]> {
    return request<MigrationRun[]>(`/migration-runs?workspaceId=${workspaceId}`, {}, MOCK_MIGRATION_RUNS);
  },

  async getMigrationRun(runId: string): Promise<MigrationRun> {
    const fallback = MOCK_MIGRATION_RUNS.find((r) => r.id === runId) || MOCK_MIGRATION_RUNS[0];
    return request<MigrationRun>(`/migration-runs/${runId}`, {}, fallback);
  },

  async startMigrationRun(planVersionId: string): Promise<{ runId: string; status: string; planHash: string }> {
    return request('/migration-runs', {
      method: 'POST',
      body: JSON.stringify({ planVersionId }),
    });
  },

  async getMigrationBatches(runId: string, page = 1, limit = 50): Promise<MigrationBatch[]> {
    const res = await request<any>(
      `/migration-runs/${runId}/batches?page=${page}&limit=${limit}`,
      {},
      { batches: MOCK_BATCHES }
    );
    return res?.batches !== undefined ? res.batches : res;
  },

  async getMigrationProgress(runId: string) {
    return request(`/migration-runs/${runId}/progress`, {}, {
      runId,
      status: 'RUNNING',
      percentage: 85,
      processedRecords: 8500,
      totalRecords: 10000,
      throughputRecordsPerSec: 425,
      estimatedTimeRemainingSeconds: 3.5,
    });
  },

  async pauseRun(runId: string) {
    return request(`/migration-runs/${runId}/pause`, { method: 'POST' }, { status: 'PAUSED' });
  },

  async resumeRun(runId: string) {
    return request(`/migration-runs/${runId}/resume`, { method: 'POST' }, { status: 'RUNNING' });
  },

  async cancelRun(runId: string) {
    return request(`/migration-runs/${runId}/cancel`, { method: 'POST' }, { status: 'CANCELLED' });
  },

  async retryFailedBatches(runId: string) {
    return request(`/migration-runs/${runId}/retry-failed`, { method: 'POST' }, { retriedCount: 1 });
  },

  // Validation Center
  async triggerValidation(runId: string): Promise<ValidationRun> {
    return request<ValidationRun>(`/migration-runs/${runId}/validations`, { method: 'POST' });
  },

  async getValidationRun(runId: string): Promise<ValidationRun> {
    return request<ValidationRun>(`/migration-runs/${runId}/validations`, {}, MOCK_VALIDATION_RUN);
  },

  async getValidationChecks(validationRunId: string) {
    return request(`/validation-runs/${validationRunId}/checks`, {}, MOCK_VALIDATION_RUN.checks);
  },

  async getDiscrepancies(
    runIdOrValId: string,
    filters?: { category?: string; severity?: string; status?: string; page?: number; limit?: number }
  ): Promise<DiscrepancyRecord[]> {
    const params = new URLSearchParams();
    if (filters?.category && filters.category !== 'ALL') params.set('category', filters.category);
    if (filters?.severity && filters.severity !== 'ALL') params.set('severity', filters.severity);
    if (filters?.status && filters.status !== 'ALL') params.set('status', filters.status);
    if (filters?.page) params.set('page', String(filters.page));
    if (filters?.limit) params.set('limit', String(filters.limit));

    const qs = params.toString() ? `?${params.toString()}` : '';

    const res = await request<any>(
      `/validation-runs/${runIdOrValId}/discrepancies${qs}`,
      {},
      { discrepancies: MOCK_DISCREPANCIES }
    );
    const list =
      res?.discrepancies !== undefined
        ? res.discrepancies
        : Array.isArray(res)
        ? res
        : isDemoModeEnabled()
        ? MOCK_DISCREPANCIES
        : [];
    return list;
  },

  async updateDiscrepancyStatus(discrepancyId: string, status: string, notes?: string) {
    return request(`/discrepancies/${discrepancyId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, notes }),
    });
  },

  // AI Copilot & Failure Investigation
  async sendCopilotMessage(userMessage: string, runId?: string, validationRunId?: string): Promise<CopilotMessage> {
    const fallbackResponse: CopilotMessage = {
      id: `copilot-${Date.now()}`,
      sender: 'assistant',
      content: `I analyzed your request: "${userMessage}".\n\nI reviewed the migration run and discovered that discrepancies are isolated to known deterministic test conditions. No data corruption occurred on active records.`,
      timestamp: new Date().toISOString(),
      evidenceRefs: [
        { type: 'RUN', id: runId || 'run-default', label: 'Migration Run' },
        { type: 'DISCREPANCY', id: validationRunId || 'val-default', label: 'Seeded Defects Benchmark' },
      ],
    };

    return request(
      '/ai/conversations/default/messages',
      {
        method: 'POST',
        body: JSON.stringify({ message: userMessage, runId, validationRunId }),
      },
      fallbackResponse
    );
  },

  async analyzeDiscrepancies(validationRunId: string, category?: string) {
    return request(`/validation-runs/${validationRunId}/ai-analysis`, {
      method: 'POST',
      body: JSON.stringify({ category }),
    });
  },

  // Reports
  async generateReport(
    validationRunId: string,
    reportType: 'EXECUTIVE' | 'DETAILED' | 'AUDIT' = 'DETAILED',
    format: 'HTML' | 'CSV' = 'HTML'
  ) {
    return request(`/validation-runs/${validationRunId}/reports`, {
      method: 'POST',
      body: JSON.stringify({ reportType, format }),
    });
  },

  async downloadReport(reportId: string): Promise<string> {
    return request(`/reports/${reportId}/download`);
  },

  // Audit Events
  async getAuditEvents(workspaceId = 'default', limit = 50): Promise<AuditEvent[]> {
    return request<AuditEvent[]>(
      `/workspaces/${workspaceId}/audit-events?limit=${limit}`,
      {},
      MOCK_AUDIT_EVENTS
    );
  },
};
