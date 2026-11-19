import {
  ObjectMapping,
  ChildRow,
} from '../types/index.js';
import { TransformationEngine, getByPath } from './engine.js';
import { normalizeBsonValue } from './operations.js';

export interface FieldTransformDiff {
  sourceField: string;
  sourceValue: unknown;
  destinationField: string;
  destinationValue: unknown;
  operations: string[];
}

export interface SamplePreviewItem {
  index: number;
  sourceKey: string;
  destinationKey: string;
  sourceRecord: Record<string, unknown>;
  transformedRecord?: Record<string, unknown>;
  childRows?: ChildRow[];
  fieldDiffs: FieldTransformDiff[];
  canonicalHash?: string;
  warnings: string[];
  error?: string;
}

export interface TransformPreviewResult {
  objectName: string;
  destinationObject: string;
  totalSamples: number;
  successfulSamples: number;
  failedSamples: number;
  totalWarnings: number;
  samples: SamplePreviewItem[];
  durationMs: number;
}

/**
 * Previews sample transformations for an object mapping without writing to destination tables.
 */
export function previewTransform(
  mapping: ObjectMapping,
  sampleRecords: Array<Record<string, unknown>>
): TransformPreviewResult {
  const startTime = Date.now();
  const engine = new TransformationEngine(mapping);
  const previewItems: SamplePreviewItem[] = [];

  let successful = 0;
  let failed = 0;
  let totalWarnings = 0;

  sampleRecords.forEach((record, index) => {
    const sourceKeyVal = getByPath(record, mapping.identity.sourceKey);
    const sourceKey = sourceKeyVal !== undefined && sourceKeyVal !== null ? String(sourceKeyVal) : `sample_${index}`;

    try {
      const transformed = engine.transform(record);
      const warnings = transformed.warnings || [];
      totalWarnings += warnings.length;

      // Build field-level diffs
      const fieldDiffs: FieldTransformDiff[] = [];
      for (const field of mapping.fields) {
        const rawSourceVal = getByPath(record, field.sourcePath);
        const destVal = getByPath(transformed.payload, field.destinationPath);

        const ops: string[] = [];
        if (field.transform) {
          const cfgs = Array.isArray(field.transform) ? field.transform : [field.transform];
          for (const c of cfgs) {
            ops.push(c.op);
          }
        } else {
          ops.push('DIRECT_ASSIGN');
        }

        fieldDiffs.push({
          sourceField: field.sourcePath,
          sourceValue: normalizeBsonValue(rawSourceVal),
          destinationField: field.destinationPath,
          destinationValue: destVal,
          operations: ops,
        });
      }

      successful++;
      previewItems.push({
        index,
        sourceKey,
        destinationKey: transformed.destinationKey,
        sourceRecord: record,
        transformedRecord: transformed.payload,
        childRows: transformed.childRows,
        fieldDiffs,
        canonicalHash: transformed.canonicalHash,
        warnings,
      });
    } catch (err) {
      failed++;
      previewItems.push({
        index,
        sourceKey,
        destinationKey: 'ERROR',
        sourceRecord: record,
        fieldDiffs: [],
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    objectName: mapping.source.collection,
    destinationObject: mapping.destination.schema
      ? `${mapping.destination.schema}.${mapping.destination.table}`
      : mapping.destination.table,
    totalSamples: sampleRecords.length,
    successfulSamples: successful,
    failedSamples: failed,
    totalWarnings,
    samples: previewItems,
    durationMs: Date.now() - startTime,
  };
}
