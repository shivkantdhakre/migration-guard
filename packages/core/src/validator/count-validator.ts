import {
  Discrepancy,
  DiscrepancyCategory,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface CountValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
}

export class CountValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;

  constructor(options: CountValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-COUNT-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
  }

  public validate(
    sourceCount: number,
    destinationCount: number,
    entityName = 'records'
  ): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];

    const isMatch = sourceCount === destinationCount;
    const evaluatedCount = Math.max(sourceCount, destinationCount);

    if (!isMatch) {
      discrepancies.push({
        issueId: `DISC-COUNT-${this.sourceObject}-${Date.now()}`,
        migrationRunId: this.migrationRunId,
        validationRunId: this.validationRunId,
        sourceKey: null,
        destinationKey: null,
        category: 'RECORD_COUNT_MISMATCH',
        severity: 'CRITICAL',
        expectedValue: sourceCount,
        actualValue: destinationCount,
        explanation: `Total ${entityName} count mismatch for ${this.sourceObject} -> ${this.destinationObject}. Expected ${sourceCount}, but found ${destinationCount} in destination (diff: ${destinationCount - sourceCount}).`,
        timestamp: new Date().toISOString(),
        status: 'OPEN',
        sourceObject: this.sourceObject,
        destinationObject: this.destinationObject,
        metadata: {
          sourceCount,
          destinationCount,
          difference: destinationCount - sourceCount,
          entityName,
        },
      });
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = isMatch ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Record Count Reconciliation (${this.sourceObject} -> ${this.destinationObject})`,
      category: 'RECORD_COUNT_MISMATCH',
      state,
      evaluatedCount,
      passedCount: isMatch ? evaluatedCount : Math.min(sourceCount, destinationCount),
      failedCount: isMatch ? 0 : Math.abs(sourceCount - destinationCount),
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        sourceCount,
        destinationCount,
        entityName,
      },
    };
  }
}
