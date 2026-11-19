import { z } from 'zod';

export const EvidenceRefSchema = z.object({
  type: z.enum([
    'SNAPSHOT',
    'PROFILE',
    'RUN',
    'BATCH',
    'DISCREPANCY',
    'MAPPING',
    'PLAN',
    'LOG',
  ]),
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const CopilotFactSchema = z.object({
  statement: z.string().min(1),
  evidenceRef: EvidenceRefSchema,
});

export const CopilotHypothesisSchema = z.object({
  statement: z.string().min(1),
  confidence: z.number().min(0).max(1),
  basis: z.string().min(1),
});

export const CopilotResponseSchema = z.object({
  schemaVersion: z.literal('copilot-response.v1').default('copilot-response.v1'),
  answer: z.string().min(1),
  facts: z.array(CopilotFactSchema).default([]),
  hypotheses: z.array(CopilotHypothesisSchema).default([]),
  recommendations: z.array(z.string()).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).default([]),
  proposalId: z.string().optional(),
});

export type CopilotResponse = z.infer<typeof CopilotResponseSchema>;
export type CopilotFact = z.infer<typeof CopilotFactSchema>;
export type CopilotHypothesis = z.infer<typeof CopilotHypothesisSchema>;
