import {
  Discrepancy,
  DiscrepancyCategory,
  DiscrepancySeverity,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface FieldComparisonRule {
  fieldPath: string;
  sourcePath?: string;
  destinationPath?: string;
  expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  nullable?: boolean;
  tolerance?: number; // for floating point comparisons
  customComparator?: (srcVal: any, destVal: any) => boolean;
}

export interface FieldValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
  rules?: FieldComparisonRule[];
  keyExtractor?: (record: any) => string;
}

function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const p of parts) {
    if (curr === null || curr === undefined) return undefined;
    curr = curr[p];
  }
  return curr;
}

export class FieldValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;
  private rules: FieldComparisonRule[];
  private keyExtractor: (record: any) => string;

  constructor(options: FieldValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-FIELD-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
    this.rules = options.rules || [];
    this.keyExtractor = options.keyExtractor || ((r: any) => r.id || r._id || r.source_id);
  }

  public validate(
    sourceRecords: any[],
    destinationRecords: any[]
  ): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];

    const destMap = new Map<string, any>();
    for (const d of destinationRecords) {
      const key = this.keyExtractor(d);
      if (key && !destMap.has(key)) {
        destMap.set(key, d);
      }
    }

    let evaluatedCount = 0;
    let passedCount = 0;
    let failedCount = 0;

    for (const src of sourceRecords) {
      const key = this.keyExtractor(src);
      if (!key) continue;

      const dest = destMap.get(key);
      if (!dest) continue;

      for (const rule of this.rules) {
        evaluatedCount++;
        const srcPath = rule.sourcePath || rule.fieldPath;
        const destPath = rule.destinationPath || rule.fieldPath;

        const srcVal = getNestedValue(src, srcPath);
        const destVal = getNestedValue(dest, destPath);

        // 1. Nullability check
        if (!rule.nullable && (destVal === null || destVal === undefined) && srcVal !== null && srcVal !== undefined) {
          failedCount++;
          discrepancies.push({
            issueId: `DISC-NULL-${key}-${rule.fieldPath}`,
            migrationRunId: this.migrationRunId,
            validationRunId: this.validationRunId,
            sourceKey: key,
            destinationKey: this.keyExtractor(dest),
            category: 'NULLABILITY_MISMATCH',
            severity: 'HIGH',
            expectedValue: srcVal,
            actualValue: destVal,
            explanation: `Non-nullable destination field '${destPath}' received null/undefined for record '${key}'. Expected: ${JSON.stringify(srcVal)}`,
            timestamp: new Date().toISOString(),
            status: 'OPEN',
            fieldPath: destPath,
            sourceObject: this.sourceObject,
            destinationObject: this.destinationObject,
          });
          continue;
        }

        // 2. Type validation
        if (rule.expectedType && destVal !== null && destVal !== undefined) {
          const actualType = Array.isArray(destVal) ? 'array' : typeof destVal;
          if (actualType !== rule.expectedType) {
            failedCount++;
            discrepancies.push({
              issueId: `DISC-TYPE-${key}-${rule.fieldPath}`,
              migrationRunId: this.migrationRunId,
              validationRunId: this.validationRunId,
              sourceKey: key,
              destinationKey: this.keyExtractor(dest),
              category: 'TYPE_MISMATCH',
              severity: 'HIGH',
              expectedValue: rule.expectedType,
              actualValue: actualType,
              explanation: `Field '${destPath}' in record '${key}' has incorrect type. Expected ${rule.expectedType}, observed ${actualType}.`,
              timestamp: new Date().toISOString(),
              status: 'OPEN',
              fieldPath: destPath,
              sourceObject: this.sourceObject,
              destinationObject: this.destinationObject,
            });
            continue;
          }
        }

        // 3. Value comparison
        let isMatch = true;
        if (rule.customComparator) {
          isMatch = rule.customComparator(srcVal, destVal);
        } else if (rule.tolerance !== undefined && typeof srcVal === 'number' && typeof destVal === 'number') {
          isMatch = Math.abs(srcVal - destVal) <= rule.tolerance;
        } else if (typeof srcVal === 'object' && srcVal !== null) {
          isMatch = JSON.stringify(srcVal) === JSON.stringify(destVal);
        } else {
          isMatch = srcVal === destVal;
        }

        if (!isMatch) {
          failedCount++;
          discrepancies.push({
            issueId: `DISC-FIELD-${key}-${rule.fieldPath}`,
            migrationRunId: this.migrationRunId,
            validationRunId: this.validationRunId,
            sourceKey: key,
            destinationKey: this.keyExtractor(dest),
            category: 'FIELD_VALUE_MISMATCH',
            severity: 'MEDIUM',
            expectedValue: srcVal,
            actualValue: destVal,
            explanation: `Value mismatch at field '${rule.fieldPath}' for record '${key}'. Expected '${srcVal}', found '${destVal}'.`,
            timestamp: new Date().toISOString(),
            status: 'OPEN',
            fieldPath: destPath,
            sourceObject: this.sourceObject,
            destinationObject: this.destinationObject,
          });
        } else {
          passedCount++;
        }
      }
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Field-Level & Type Comparison (${this.sourceObject} -> ${this.destinationObject})`,
      category: 'FIELD_VALUE_MISMATCH',
      state,
      evaluatedCount,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalRules: this.rules.length,
        evaluatedFields: evaluatedCount,
        discrepancyCount: failedCount,
      },
    };
  }
}
