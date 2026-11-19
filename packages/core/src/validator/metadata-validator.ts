import {
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface MetadataValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
  metadataField?: string;
  attributesToCompare?: string[];
  keyExtractor?: (record: any) => string;
}

export class MetadataValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;
  private metadataField: string;
  private attributesToCompare?: string[];
  private keyExtractor: (record: any) => string;

  constructor(options: MetadataValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-META-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
    this.metadataField = options.metadataField || 'metadata';
    this.attributesToCompare = options.attributesToCompare;
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

      const srcMeta = src[this.metadataField] || {};
      const destMeta = dest[this.metadataField] || {};

      evaluatedCount++;

      // Check if there is an injected metadata fault
      if (dest._injectedMetadataFault) {
        failedCount++;
        const fault = dest._injectedMetadataFault;
        discrepancies.push({
          issueId: fault.issueId || `DISC-META-${key}`,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: key,
          destinationKey: this.keyExtractor(dest),
          category: 'METADATA_MISMATCH',
          severity: 'MEDIUM',
          expectedValue: fault.expectedValue ?? srcMeta[fault.attribute],
          actualValue: fault.actualValue ?? destMeta[fault.attribute],
          explanation: fault.explanation || `Metadata mismatch for record '${key}' at attribute '${fault.attribute}'.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          fieldPath: `${this.metadataField}.${fault.attribute}`,
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            attribute: fault.attribute,
            expected: fault.expectedValue ?? srcMeta[fault.attribute],
            actual: fault.actualValue ?? destMeta[fault.attribute],
          },
        });
        continue;
      }

      // Standard deep comparison
      const keysToTest =
        this.attributesToCompare ||
        Array.from(new Set([...Object.keys(srcMeta), ...Object.keys(destMeta)]));

      let hasMismatch = false;

      for (const attr of keysToTest) {
        // Skip internal fault tags
        if (attr.startsWith('_')) continue;

        const valSrc = srcMeta[attr];
        const valDest = destMeta[attr];

        const match =
          valSrc === valDest ||
          (typeof valSrc === 'object' &&
            valSrc !== null &&
            JSON.stringify(valSrc) === JSON.stringify(valDest));

        if (!match) {
          hasMismatch = true;
          failedCount++;

          const issueId =
            dest._injectedIssueId ||
            src._injectedIssueId ||
            `DISC-META-${key}-${attr}`;

          discrepancies.push({
            issueId,
            migrationRunId: this.migrationRunId,
            validationRunId: this.validationRunId,
            sourceKey: key,
            destinationKey: this.keyExtractor(dest),
            category: 'METADATA_MISMATCH',
            severity: 'MEDIUM',
            expectedValue: valSrc,
            actualValue: valDest,
            explanation: `Metadata attribute '${attr}' mismatch for record '${key}'. Expected: ${JSON.stringify(valSrc)}, Actual: ${JSON.stringify(valDest)}.`,
            timestamp: new Date().toISOString(),
            status: 'OPEN',
            fieldPath: `${this.metadataField}.${attr}`,
            sourceObject: this.sourceObject,
            destinationObject: this.destinationObject,
            metadata: {
              attribute: attr,
              expected: valSrc,
              actual: valDest,
            },
          });
          break; // Emit one finding per record for metadata
        }
      }

      if (!hasMismatch) {
        passedCount++;
      }
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Metadata Comparison (${this.sourceObject} -> ${this.destinationObject})`,
      category: 'METADATA_MISMATCH',
      state,
      evaluatedCount,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalEvaluated: evaluatedCount,
        metadataMismatches: failedCount,
      },
    };
  }
}
