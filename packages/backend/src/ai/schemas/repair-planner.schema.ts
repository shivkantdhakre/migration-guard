import { z } from 'zod';
import { ALLOWLISTED_REPAIR_OPERATIONS } from '../types.js';

export const RepairScopeSchema = z.object({
  validationRunId: z.string().optional(),
  discrepancyIds: z.array(z.string()).optional(),
  batchId: z.string().optional(),
  recordKeys: z.array(z.string()).optional(),
});

export const RepairProposalSchema = z
  .object({
    schemaVersion: z.literal('repair-proposal.v1').default('repair-proposal.v1'),
    proposalId: z.string(),
    operation: z.enum(ALLOWLISTED_REPAIR_OPERATIONS as [string, ...string[]]),
    scope: RepairScopeSchema,
    mappingVersionId: z.string().optional(),
    preconditions: z.array(z.string()).min(1),
    expectedEffects: z.array(z.string()).min(1),
    risks: z.array(z.string()).default([]),
    requiresDryRun: z.literal(true).default(true),
    requiresApproval: z.literal(true).default(true),
    // Defense against injection: explicitly reject arbitrary sql or shell command fields
    executableScript: z.never().optional(),
    sqlCommand: z.never().optional(),
    shellCommand: z.never().optional(),
  })
  .strict(); // Strict mode forbids any extra unknown fields such as "rawSql", "shellCommand"

export type RepairScope = z.infer<typeof RepairScopeSchema>;
export type RepairProposal = z.infer<typeof RepairProposalSchema>;
