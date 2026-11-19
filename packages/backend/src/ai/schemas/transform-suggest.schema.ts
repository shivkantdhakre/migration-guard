import { z } from 'zod';
import { TransformOpEnum } from './schema-mapping.schema.js';

export const TransformSuggestionSchema = z.object({
  schemaVersion: z.literal('transform-suggestion.v1').default('transform-suggestion.v1'),
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  sourceSampleValue: z.unknown().optional(),
  targetType: z.string().min(1),
  suggestedOperation: TransformOpEnum,
  params: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  previewSimulation: z
    .object({
      sampleInput: z.unknown(),
      sampleOutput: z.unknown(),
    })
    .optional(),
  requiresReview: z.boolean().default(true),
});

export type TransformSuggestion = z.infer<typeof TransformSuggestionSchema>;
