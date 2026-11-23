import {
  computeCanonicalHash,
  CanonicalizeOptions,
} from './canonicalizer.js';
import {
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface HashValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
  canonicalOptions?: CanonicalizeOptions;
  keyExtractor?: (record: any) => string;
}

export class HashValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;
  private canonicalOptions: CanonicalizeOptions;
  private keyExtractor: (record: any) => string;

  constructor(options: HashValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-HASH-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'customers';
    this.destinationObject = options.destinationObject || 'customers';
    this.canonicalOptions = options.canonicalOptions || {
      excludeFields: ['extractedAt', '_injectedIssueId', '_defectId', '_faultDetails'],
    };
    this.keyExtractor = options.keyExtractor || ((r: any) => r.id || r._id || r.source_id);
  }

  public validate(
    sourceRecords: any[],
    destinationRecords: any[],
    normalizer?: (sourceRecord: any) => any,
    destNormalizer?: (destRecord: any) => any
  ): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];

    // Map destination records by key
    const destMap = new Map<string, any>();
    for (const d of destinationRecords) {
      const key = this.keyExtractor(d);
      if (key && !destMap.has(key)) {
        destMap.set(key, d);
      }
    }

    let passedCount = 0;
    let failedCount = 0;

    for (const src of sourceRecords) {
      const key = this.keyExtractor(src);
      if (!key) continue;

      const dest = destMap.get(key);
      if (!dest) {
        // Missing record handled by missing-record-validator
        continue;
      }

      const normalizedSrc = normalizer ? normalizer(src) : src;
      const normalizedDest = destNormalizer ? destNormalizer(dest) : dest;
      const srcHash = computeCanonicalHash(normalizedSrc, this.canonicalOptions);
      const destHash = computeCanonicalHash(normalizedDest, this.canonicalOptions);

      if (srcHash !== destHash) {
        failedCount++;
        const issueId =
          dest._injectedIssueId ||
          src._injectedIssueId ||
          `DISC-HASH-${key}`;

        discrepancies.push({
          issueId,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: key,
          destinationKey: this.keyExtractor(dest),
          category: 'CONTENT_HASH_MISMATCH',
          severity: 'HIGH',
          expectedValue: srcHash,
          actualValue: destHash,
          explanation: `Canonical SHA-256 content hash mismatch for key '${key}'. Expected source hash ${srcHash.slice(0, 16)}..., but got destination hash ${destHash.slice(0, 16)}...`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            expectedHash: srcHash,
            actualHash: destHash,
            algorithm: 'SHA-256',
            canonicalizationVersion: '1.0',
          },
        });
      } else {
        passedCount++;
      }
    }

    const durationMs = Date.now() - start;
    const evaluatedCount = passedCount + failedCount;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Canonical Content Hash Verification (${this.sourceObject} -> ${this.destinationObject})`,
      category: 'CONTENT_HASH_MISMATCH',
      state,
      evaluatedCount,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        hashAlgorithm: 'SHA-256',
        totalEvaluated: evaluatedCount,
        mismatchCount: failedCount,
      },
    };
  }
}
