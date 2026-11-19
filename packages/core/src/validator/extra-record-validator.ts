import {
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface ExtraRecordValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
}

export class ExtraRecordValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;

  constructor(options: ExtraRecordValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-EXTRA-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
  }

  public validate(
    destinationKeys: string[],
    expectedSourceKeys: Set<string> | string[]
  ): ValidationCheckResult {
    const start = Date.now();
    const sourceSet = expectedSourceKeys instanceof Set ? expectedSourceKeys : new Set(expectedSourceKeys);
    const discrepancies: Discrepancy[] = [];

    let passedCount = 0;
    let failedCount = 0;

    for (const destKey of destinationKeys) {
      if (!sourceSet.has(destKey)) {
        failedCount++;
        discrepancies.push({
          issueId: `DISC-EXTRA-${destKey}`,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: null,
          destinationKey: destKey,
          category: 'EXTRA_RECORD',
          severity: 'HIGH',
          expectedValue: 'Record should not exist or be linked to source manifest',
          actualValue: `Record ${destKey} present in destination`,
          explanation: `Destination record ${destKey} in ${this.destinationObject} has no corresponding origin record in source ${this.sourceObject} or manifest.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            unexpectedDestinationKey: destKey,
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
      checkName: `Unexpected / Extra Record Detection (${this.destinationObject})`,
      category: 'EXTRA_RECORD',
      state,
      evaluatedCount: destinationKeys.length,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalEvaluated: destinationKeys.length,
        extraCount: failedCount,
      },
    };
  }
}
