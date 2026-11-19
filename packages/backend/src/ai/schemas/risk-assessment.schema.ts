import { z } from 'zod';

export const RiskFindingCategoryEnum = z.enum([
  'LOSSY_TRANSFORM',
  'INCOMPATIBLE_TYPE',
  'MISSING_CONSTRAINT',
  'VOLUME_SCALE',
  'REFERENTIAL_INTEGRITY',
  'UNMAPPED_REQUIRED_FIELD',
]);

export const RiskSeverityEnum = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

export const RiskFindingSchema = z.object({
  id: z.string(),
  category: RiskFindingCategoryEnum,
  severity: RiskSeverityEnum,
  sourceField: z.string().optional(),
  targetField: z.string().optional(),
  description: z.string().min(1),
  mitigation: z.string().min(1),
  isFact: z.boolean().default(false), // true if verified by schema check, false if LLM hypothesis
  evidenceRef: z.string().optional(),
});

export const RiskAssessmentSchema = z.object({
  schemaVersion: z.literal('risk-assessment.v1').default('risk-assessment.v1'),
  overallRiskLevel: RiskSeverityEnum,
  measuredFactsCount: z.number().int().min(0),
  hypothesesCount: z.number().int().min(0),
  findings: z.array(RiskFindingSchema),
  recommendations: z.array(z.string()).default([]),
  readinessPass: z.boolean(),
});

export type RiskFinding = z.infer<typeof RiskFindingSchema>;
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;
