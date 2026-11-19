import {
  CustomerRecord,
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface DuplicateValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  destinationObject?: string;
  keyExtractor?: (record: any) => string;
}

export class DuplicateValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private destinationObject: string;
  private keyExtractor: (record: any) => string;

  constructor(options: DuplicateValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-DUP-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.destinationObject = options.destinationObject || 'customers';
    this.keyExtractor = options.keyExtractor || ((r: any) => r.id || r._id || r.source_id);
  }

  public validate(records: any[]): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];
    const seenKeys = new Map<string, number>();

    let passedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const key = this.keyExtractor(record);
      if (!key) continue;

      if (seenKeys.has(key)) {
        const count = seenKeys.get(key)! + 1;
        seenKeys.set(key, count);
        failedCount++;

        // Check if record has seeded defect metadata
        const issueId =
          record._injectedIssueId ||
          record.injectedIssueId ||
          record._defectId ||
          `DISC-DUP-${key}-${count}`;

        discrepancies.push({
          issueId,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: record.source_id || key,
          destinationKey: key,
          category: 'DUPLICATE_RECORD',
          severity: 'HIGH',
          expectedValue: `Unique occurrence for key ${key}`,
          actualValue: `Duplicate record observed at index ${i} (occurrence #${count})`,
          explanation: `Duplicate record detected for key '${key}' in ${this.destinationObject}. Key was already seen previously in dataset.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          sourceObject: this.destinationObject,
          destinationObject: this.destinationObject,
          metadata: {
            duplicateKey: key,
            occurrence: count,
            index: i,
            ...(record._faultDetails || {}),
          },
        });
      } else {
        seenKeys.set(key, 1);
        passedCount++;
      }
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Duplicate Record Detection (${this.destinationObject})`,
      category: 'DUPLICATE_RECORD',
      state,
      evaluatedCount: records.length,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalEvaluated: records.length,
        uniqueCount: seenKeys.size,
        duplicateCount: failedCount,
      },
    };
  }
}
