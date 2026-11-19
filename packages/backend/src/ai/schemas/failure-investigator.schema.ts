import { z } from 'zod';
import { ALLOWLISTED_REPAIR_OPERATIONS } from '../types.js';

export const ErrorClassificationEnum = z.enum([
  'RETRYABLE',
  'PERMANENT',
  'OUTCOME_UNKNOWN',
]);

export const FailureHypothesisSchema = z.object({
  id: z.string(),
  hypothesis: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  affectedBatches: z.array(z.string()).default([]),
  affectedRecords: z.array(z.string()).default([]),
  evidenceRef: z.string().optional(),
});

export const FailureInvestigationSchema = z.object({
  schemaVersion: z.literal('failure-investigation.v1').default('failure-investigation.v1'),
  runId: z.string(),
  errorClassification: ErrorClassificationEnum,
  isPermanent: z.boolean(),
  hypotheses: z.array(FailureHypothesisSchema),
  diagnosticSteps: z.array(z.string()).default([]),
  suggestedRemediation: z.enum(ALLOWLISTED_REPAIR_OPERATIONS as [string, ...string[]]),
  requiresHumanReview: z.boolean().default(true),
});

export type FailureHypothesis = z.infer<typeof FailureHypothesisSchema>;
export type FailureInvestigation = z.infer<typeof FailureInvestigationSchema>;
