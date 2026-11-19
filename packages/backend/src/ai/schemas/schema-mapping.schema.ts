import { z } from 'zod';

export const ALLOWLISTED_TRANSFORM_OPS = [
  'RENAME',
  'TRIM_STRING',
  'LOWERCASE',
  'UPPERCASE',
  'PARSE_INTEGER',
  'PARSE_DECIMAL',
  'PARSE_TIMESTAMP',
  'TO_JSONB',
  'FLATTEN_OBJECT',
  'ARRAY_TO_CHILD_ROWS',
  'SET_DEFAULT',
  'NULL_IF_EMPTY',
  'PRESERVE_SOURCE_ID',
] as const;

export const TransformOpEnum = z.enum(ALLOWLISTED_TRANSFORM_OPS);

export const FieldMappingProposalSchema = z.object({
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  transform: z.object({
    op: TransformOpEnum,
    params: z.record(z.unknown()).optional(),
  }),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  requiresReview: z.boolean().default(true),
});

export const UnresolvedFieldSchema = z.object({
  sourcePath: z.string().min(1),
  reason: z.string().min(1),
  question: z.string().min(1),
});

export const SchemaMappingProposalSchema = z.object({
  schemaVersion: z.literal('mapping-proposal.v1').default('mapping-proposal.v1'),
  sourceObject: z.string().min(1),
  destinationObject: z.string().min(1),
  proposals: z.array(FieldMappingProposalSchema),
  unresolved: z.array(UnresolvedFieldSchema).default([]),
  overallConfidence: z.number().min(0).max(1).default(0.85),
});

export type FieldMappingProposal = z.infer<typeof FieldMappingProposalSchema>;
export type UnresolvedField = z.infer<typeof UnresolvedFieldSchema>;
export type SchemaMappingProposal = z.infer<typeof SchemaMappingProposalSchema>;
