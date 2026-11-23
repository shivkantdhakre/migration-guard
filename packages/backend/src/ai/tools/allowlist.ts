import { z } from 'zod';
import { ActorRole } from '../types.js';

export interface ToolDefinition<TInput = any, TOutput = any> {
  name: string;
  description: string;
  isReadOnly: boolean;
  allowedRoles: readonly ActorRole[];
  inputSchema: z.ZodType<TInput>;
  maxPayloadBytes: number;
}

export const ALLOWLISTED_TOOLS: Record<string, ToolDefinition> = {
  get_schema_snapshot: {
    name: 'get_schema_snapshot',
    description: 'Read a schema snapshot for a source or target connection (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      snapshotId: z.string().min(1),
      includeFieldDetails: z.boolean().default(true),
    }),
    maxPayloadBytes: 256 * 1024,
  },
  get_profile_summary: {
    name: 'get_profile_summary',
    description: 'Read aggregate data profiling summary for a snapshot (null %, types, counts)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      snapshotId: z.string().min(1),
      collectionOrTable: z.string().optional(),
    }),
    maxPayloadBytes: 256 * 1024,
  },
  get_connector_capabilities: {
    name: 'get_connector_capabilities',
    description: 'Read connector capabilities and limitations (e.g. MongoDB, PostgreSQL)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      engine: z.enum(['MONGODB', 'POSTGRESQL']),
    }),
    maxPayloadBytes: 64 * 1024,
  },
  get_mapping_version: {
    name: 'get_mapping_version',
    description: 'Read mapping configuration and rules for a version ID (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      mappingVersionId: z.string().min(1),
    }),
    maxPayloadBytes: 128 * 1024,
  },
  preview_transform: {
    name: 'preview_transform',
    description: 'Execute mapping transforms on a bounded sample fixture (sandboxed, no writes)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER'],
    inputSchema: z.object({
      mappingVersionId: z.string().optional(),
      rules: z.array(z.record(z.unknown())).optional(),
      sampleRecord: z.record(z.unknown()),
    }),
    maxPayloadBytes: 64 * 1024,
  },
  get_run_summary: {
    name: 'get_run_summary',
    description: 'Read migration run counters, state, and batch progress (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      runId: z.string().min(1),
    }),
    maxPayloadBytes: 64 * 1024,
  },
  get_batch_errors: {
    name: 'get_batch_errors',
    description: 'Read sanitized error codes and affected keys for failed batches (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      runId: z.string().min(1),
      batchId: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    maxPayloadBytes: 256 * 1024,
  },
  get_discrepancy_evidence: {
    name: 'get_discrepancy_evidence',
    description: 'Read validation discrepancies and evidence references (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      validationRunId: z.string().min(1),
      category: z.string().optional(),
      severity: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    maxPayloadBytes: 256 * 1024,
  },
  compare_sample_records: {
    name: 'compare_sample_records',
    description: 'Compare normalized source and destination sample records (read-only)',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'],
    inputSchema: z.object({
      sourceRecordId: z.string().min(1),
      destinationRecordId: z.string().min(1),
      sourceRecord: z.record(z.unknown()).optional(),
      destinationRecord: z.record(z.unknown()).optional(),
    }),
    maxPayloadBytes: 64 * 1024,
  },
  validate_plan_draft: {
    name: 'validate_plan_draft',
    description: 'Run deterministic checks on a draft migration plan proposal',
    isReadOnly: true,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER'],
    inputSchema: z.object({
      planDraft: z.record(z.unknown()).optional(),
    }),
    maxPayloadBytes: 128 * 1024,
  },
  create_draft_proposal: {
    name: 'create_draft_proposal',
    description: 'Save an unapproved draft proposal for human review',
    isReadOnly: false,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER'],
    inputSchema: z.object({
      proposalType: z.enum(['PLAN', 'MAPPING', 'REPAIR']),
      content: z.record(z.unknown()),
      rationale: z.string(),
    }),
    maxPayloadBytes: 256 * 1024,
  },
  request_human_approval: {
    name: 'request_human_approval',
    description: 'Initiate a human approval workflow for a draft proposal',
    isReadOnly: false,
    allowedRoles: ['OWNER', 'ADMIN', 'ENGINEER'],
    inputSchema: z.object({
      proposalId: z.string().min(1),
      summary: z.string().min(1),
    }),
    maxPayloadBytes: 64 * 1024,
  },
};
