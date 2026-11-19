import { z } from 'zod';

export const MigrationPlanProposalSchema = z.object({
  schemaVersion: z.literal('plan-proposal.v1').default('plan-proposal.v1'),
  userObjective: z.string().min(1),
  sourceConnectionId: z.string(),
  targetConnectionId: z.string(),
  strategy: z.object({
    batchSize: z.number().int().min(1).max(50000).default(1000),
    concurrency: z.number().int().min(1).max(32).default(4),
    writeMode: z.enum(['INSERT_ONLY', 'UPSERT_BY_KEY']).default('UPSERT_BY_KEY'),
    idStrategy: z.enum(['PRESERVE_AS_TEXT', 'MAP_TO_UUID', 'INCREMENTAL_MAP']).default('PRESERVE_AS_TEXT'),
    retryLimit: z.number().int().min(0).max(10).default(3),
  }),
  selectedObjects: z.array(
    z.object({
      sourceCollection: z.string().min(1),
      destinationTable: z.string().min(1),
      identityMapping: z.object({
        sourceKey: z.string().default('_id'),
        destinationKey: z.string().default('source_id'),
        strategy: z.string().default('PRESERVE_AS_TEXT'),
      }),
    })
  ).min(1),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(
    z.object({
      category: z.string(),
      description: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      mitigation: z.string().optional(),
    })
  ).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
  requiresReview: z.boolean().default(true),
});

export type MigrationPlanProposal = z.infer<typeof MigrationPlanProposalSchema>;
