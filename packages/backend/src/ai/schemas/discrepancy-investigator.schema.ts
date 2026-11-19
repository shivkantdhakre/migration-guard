import { z } from 'zod';

export const DiscrepancyClusterSchema = z.object({
  clusterId: z.string(),
  name: z.string().min(1),
  category: z.enum([
    'MISSING_RECORD',
    'EXTRA_RECORD',
    'DUPLICATE_RECORD',
    'CONTENT_MISMATCH',
    'ATTACHMENT_MISSING',
    'ATTACHMENT_CHECKSUM_MISMATCH',
    'BROKEN_REFERENCE',
    'METADATA_MISMATCH',
    'TYPE_CONVERSION_ERROR',
    'VALIDATION_SKIPPED',
  ]),
  // Discrepancy IDs must be strictly linked to original discrepancy IDs
  affectedDiscrepancyIds: z.array(z.string()).min(1),
  pattern: z.string().min(1),
  hypothesisRationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  recommendedAction: z.string().min(1),
  isProvenFact: z.boolean().default(false),
});

export const DiscrepancyInvestigationSchema = z.object({
  schemaVersion: z.literal('discrepancy-investigation.v1').default('discrepancy-investigation.v1'),
  validationRunId: z.string(),
  clusters: z.array(DiscrepancyClusterSchema),
  totalDiscrepanciesAnalyzed: z.number().int().min(0),
  clusteredDiscrepancyCount: z.number().int().min(0),
  unclusteredCount: z.number().int().min(0),
  summary: z.string(),
});

export type DiscrepancyCluster = z.infer<typeof DiscrepancyClusterSchema>;
export type DiscrepancyInvestigation = z.infer<typeof DiscrepancyInvestigationSchema>;
