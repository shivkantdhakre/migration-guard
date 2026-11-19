import {
  CustomerOrder,
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface RelationshipValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  parentObject?: string;
  childObject?: string;
  parentKeyField?: string;
  childForeignKeyField?: string;
}

export class RelationshipValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private parentObject: string;
  private childObject: string;
  private parentKeyField: string;
  private childForeignKeyField: string;

  constructor(options: RelationshipValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-REL-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.parentObject = options.parentObject || 'customers';
    this.childObject = options.childObject || 'orders';
    this.parentKeyField = options.parentKeyField || 'id';
    this.childForeignKeyField = options.childForeignKeyField || 'customerId';
  }

  public validate(
    parentRecords: any[],
    childRecords: any[]
  ): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];

    // Build parent keys set
    const parentKeySet = new Set<string>();
    for (const p of parentRecords) {
      const key = p[this.parentKeyField] || p._id || p.source_id;
      if (key) parentKeySet.add(String(key));
    }

    let passedCount = 0;
    let failedCount = 0;

    for (const child of childRecords) {
      const childKey = child.orderId || child.id || child._id || child.source_id;
      const foreignKeyValue = child[this.childForeignKeyField];

      if (!foreignKeyValue || !parentKeySet.has(String(foreignKeyValue))) {
        failedCount++;
        const issueId =
          child._injectedIssueId ||
          child.injectedIssueId ||
          `DISC-REL-${childKey}`;

        discrepancies.push({
          issueId,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: childKey,
          destinationKey: childKey,
          category: 'BROKEN_REFERENCE',
          severity: 'HIGH',
          expectedValue: `Valid reference to parent in '${this.parentObject}'`,
          actualValue: foreignKeyValue ?? 'NULL_REFERENCE',
          explanation: `Child record '${childKey}' in '${this.childObject}' references non-existent parent key '${foreignKeyValue}' in '${this.parentObject}'. Foreign-key constraint violation.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          fieldPath: this.childForeignKeyField,
          sourceObject: this.childObject,
          destinationObject: this.parentObject,
          metadata: {
            childKey,
            foreignKeyField: this.childForeignKeyField,
            referencedValue: foreignKeyValue,
            parentObject: this.parentObject,
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
      checkName: `Parent-Child Relationship Integrity (${this.childObject} -> ${this.parentObject})`,
      category: 'BROKEN_REFERENCE',
      state,
      evaluatedCount: childRecords.length,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalChildren: childRecords.length,
        totalParents: parentKeySet.size,
        brokenReferences: failedCount,
      },
    };
  }
}
