import {
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface MissingRecordValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
}

export class MissingRecordValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;

  constructor(options: MissingRecordValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-MISSING-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
  }

  public validate(
    sourceKeys: string[],
    destinationKeys: Set<string> | string[]
  ): ValidationCheckResult {
    const start = Date.now();
    const destSet = destinationKeys instanceof Set ? destinationKeys : new Set(destinationKeys);
    const discrepancies: Discrepancy[] = [];

    let passedCount = 0;
    let failedCount = 0;

    for (const srcKey of sourceKeys) {
      if (!destSet.has(srcKey)) {
        failedCount++;
        discrepancies.push({
          issueId: `DISC-MISSING-${srcKey}`,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: srcKey,
          destinationKey: null,
          category: 'MISSING_RECORD',
          severity: 'CRITICAL',
          expectedValue: `Record ${srcKey} exists in destination`,
          actualValue: 'NOT_FOUND',
          explanation: `Source record ${srcKey} in collection ${this.sourceObject} was not migrated or is missing from destination table ${this.destinationObject}.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            missingSourceKey: srcKey,
          },
        });
      } else {
        passedCount++;
      }
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Missing Record Detection (${this.sourceObject})`,
      category: 'MISSING_RECORD',
      state,
      evaluatedCount: sourceKeys.length,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalEvaluated: sourceKeys.length,
        missingCount: failedCount,
      },
    };
  }
}
