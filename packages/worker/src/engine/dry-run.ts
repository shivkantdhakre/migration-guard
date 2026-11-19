/**
 * Dry-Run Engine
 * Specification Reference: FR-PLAN-003, 08_MIGRATION_ENGINE_DESIGN.md
 *
 * Executes migration transforms against a bounded sample of records without
 * modifying production destination data.
 * Validates transformed output shapes and highlights potential issues.
 */

import {
  SourceConnector,
  SourceRecordEnvelope,
  TransformedRecord,
  TransformFunction,
} from '../types.js';

export interface DryRunOptions {
  sourceObject: string;
  sampleSize?: number; // default: 50
  transformFn?: TransformFunction;
  requiredFields?: string[];
}

export interface DryRunValidationIssue {
  sourceKey: string;
  fieldPath?: string;
  message: string;
  severity: 'WARNING' | 'ERROR';
}

export interface DryRunSampleRecord {
  sourceKey: string;
  originalPayload: unknown;
  transformedData: Record<string, unknown>;
}

export interface DryRunResult {
  sourceObject: string;
  recordsRead: number;
  recordsTransformed: number;
  recordsWouldWrite: number;
  recordsFailed: number;
  sampleRecords: DryRunSampleRecord[];
  validationIssues: DryRunValidationIssue[];
  durationMs: number;
}

export class DryRunEngine {
  private connector: SourceConnector;

  constructor(connector: SourceConnector) {
    this.connector = connector;
  }

  public async execute(options: DryRunOptions): Promise<DryRunResult> {
    const startTime = Date.now();
    const sampleSize = options.sampleSize ?? 50;

    const sourceBatch = await this.connector.readBatch(null, {
      sourceObject: options.sourceObject,
      batchSize: sampleSize,
    });

    const records = sourceBatch.records || [];
    const recordsRead = records.length;
    const sampleRecords: DryRunSampleRecord[] = [];
    const validationIssues: DryRunValidationIssue[] = [];

    let recordsTransformed = 0;
    let recordsWouldWrite = 0;
    let recordsFailed = 0;

    const transformFn = options.transformFn ?? this.defaultPassThrough;

    for (const env of records) {
      try {
        const transformed = await transformFn(env);
        if (!transformed) {
          recordsFailed++;
          validationIssues.push({
            sourceKey: env.sourceKey,
            message: 'Transform returned null or undefined',
            severity: 'ERROR',
          });
          continue;
        }

        recordsTransformed++;

        // Validate required fields
        if (options.requiredFields) {
          for (const field of options.requiredFields) {
            if (transformed.data[field] === undefined || transformed.data[field] === null) {
              validationIssues.push({
                sourceKey: env.sourceKey,
                fieldPath: field,
                message: `Required destination field '${field}' is missing or null`,
                severity: 'WARNING',
              });
            }
          }
        }

        recordsWouldWrite++;

        // Keep up to 10 sample previews
        if (sampleRecords.length < 10) {
          sampleRecords.push({
            sourceKey: env.sourceKey,
            originalPayload: env.payload,
            transformedData: transformed.data,
          });
        }
      } catch (err: unknown) {
        recordsFailed++;
        const message = err instanceof Error ? err.message : String(err);
        validationIssues.push({
          sourceKey: env.sourceKey,
          message: `Transform threw error: ${message}`,
          severity: 'ERROR',
        });
      }
    }

    return {
      sourceObject: options.sourceObject,
      recordsRead,
      recordsTransformed,
      recordsWouldWrite,
      recordsFailed,
      sampleRecords,
      validationIssues,
      durationMs: Date.now() - startTime,
    };
  }

  private defaultPassThrough(env: SourceRecordEnvelope): TransformedRecord {
    const data = (env.payload && typeof env.payload === 'object')
      ? { id: env.sourceKey, ...(env.payload as Record<string, unknown>) }
      : { id: env.sourceKey, value: env.payload };

    return {
      destinationKey: env.sourceKey,
      sourceKey: env.sourceKey,
      sourceObject: env.sourceObject,
      destinationObject: env.sourceObject,
      data,
      originalEnvelope: env,
    };
  }
}
