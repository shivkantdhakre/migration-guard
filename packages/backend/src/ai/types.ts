/**
 * MigrationGuard AI Types & Interfaces
 *
 * Implements architectural boundaries and type definitions for AI agents,
 * StateGraph workflows, safety guardrails, and provider abstraction.
 *
 * Related: 07_AI_AGENT_DESIGN.md, FR-AI-001 through FR-AI-007
 */

export type AiProviderName = 'mock' | 'gemini' | 'openai';

export type AiWorkflowStatus =
  | 'INITIAL'
  | 'RUNNING'
  | 'NEEDS_INPUT'
  | 'DRAFT_READY'
  | 'COMPLETED'
  | 'REJECTED'
  | 'FAILED';

export type ActorRole = 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER';

export interface ToolExecutionContext {
  workspaceId: string;
  projectId: string;
  actorId: string;
  actorRole: ActorRole;
  runId?: string;
  validationRunId?: string;
}

export interface EvidenceRef {
  type:
    | 'SNAPSHOT'
    | 'PROFILE'
    | 'RUN'
    | 'BATCH'
    | 'DISCREPANCY'
    | 'MAPPING'
    | 'PLAN'
    | 'LOG';
  id: string;
  label: string;
  description?: string;
}

export type AllowlistedRepairOp =
  | 'RETRY_FAILED_BATCH'
  | 'REPROCESS_RECORDS_WITH_APPROVED_MAPPING'
  | 'REUPLOAD_MISSING_ATTACHMENT'
  | 'REBUILD_ID_MAPPING'
  | 'MARK_EXCEPTION_FOR_REVIEW';

export const ALLOWLISTED_REPAIR_OPERATIONS: readonly AllowlistedRepairOp[] = [
  'RETRY_FAILED_BATCH',
  'REPROCESS_RECORDS_WITH_APPROVED_MAPPING',
  'REUPLOAD_MISSING_ATTACHMENT',
  'REBUILD_ID_MAPPING',
  'MARK_EXCEPTION_FOR_REVIEW',
] as const;

export type DiscrepancyCategory =
  | 'MISSING_RECORD'
  | 'EXTRA_RECORD'
  | 'DUPLICATE_RECORD'
  | 'CONTENT_MISMATCH'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_CHECKSUM_MISMATCH'
  | 'BROKEN_REFERENCE'
  | 'METADATA_MISMATCH'
  | 'TYPE_CONVERSION_ERROR'
  | 'VALIDATION_SKIPPED';

export type DiscrepancySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResponse<T = unknown> {
  rawText: string;
  parsed?: T;
  usage: TokenUsage;
  latencyMs: number;
  model: string;
  finishReason?: string;
}

export interface GenerateOptions {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  schemaVersion?: string;
}

export interface AiProviderConfig {
  provider: AiProviderName;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
}

export interface ToolCallTrace {
  toolName: string;
  input: Record<string, unknown>;
  outputSummary: string;
  durationMs: number;
  status: 'SUCCESS' | 'ERROR';
  errorMessage?: string;
}

export interface AiTraceRecord {
  traceId: string;
  workspaceId: string;
  projectId?: string;
  agentName: string;
  provider: string;
  model: string;
  promptVersion: string;
  graphVersion: string;
  toolCalls: ToolCallTrace[];
  usage: TokenUsage;
  latencyMs: number;
  status: 'SUCCESS' | 'VALIDATION_FAILED' | 'ERROR' | 'REJECTED';
  errorMessage?: string;
  createdAt: string;
}

export interface PlanFinding {
  code: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  sourceField?: string;
  targetField?: string;
}
