import {
  AttachmentItem,
  CustomerOrder,
  CustomerRecord,
  Discrepancy,
  DiscrepancyCategory,
  DiscrepancySeverity,
  ValidationCheckResult,
  ValidationCheckState,
  ValidationDataset,
  ValidationRunSummary,
} from './discrepancy.types.js';
import { CountValidator } from './count-validator.js';
import { MissingRecordValidator } from './missing-record-validator.js';
import { ExtraRecordValidator } from './extra-record-validator.js';
import { DuplicateValidator } from './duplicate-validator.js';
import { HashValidator } from './hash-validator.js';
import { FieldComparisonRule, FieldValidator } from './field-validator.js';
import { AttachmentValidator } from './attachment-validator.js';
import { RelationshipValidator } from './relationship-validator.js';
import { MetadataValidator } from './metadata-validator.js';

export interface ValidationEngineConfig {
  migrationRunId?: string;
  runId?: string;
  validationRunId?: string;
  workspaceId?: string;
  sampleRate?: number;
  maxDiscrepancies?: number;
  fieldRules?: FieldComparisonRule[];
  metadataAttributes?: string[];
  enableChecks?: {
    count?: boolean;
    missing?: boolean;
    extra?: boolean;
    duplicate?: boolean;
    hash?: boolean;
    field?: boolean;
    attachment?: boolean;
    relationship?: boolean;
    metadata?: boolean;
  };
}

export class ValidationEngine {
  private config: ValidationEngineConfig;

  constructor(config: ValidationEngineConfig = {}) {
    this.config = {
      enableChecks: {
        count: true,
        missing: true,
        extra: true,
        duplicate: true,
        hash: true,
        field: true,
        attachment: true,
        relationship: true,
        metadata: true,
        ...config.enableChecks,
      },
      ...config,
    };
  }

  public async validate(
    source: ValidationDataset,
    destination: ValidationDataset
  ): Promise<ValidationRunSummary> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const migrationRunId = this.config.migrationRunId || this.config.runId || `run-${Date.now()}`;
    const validationRunId = this.config.validationRunId || `val-${Date.now()}`;
    const workspaceId = this.config.workspaceId;

    const checkResults: ValidationCheckResult[] = [];
    const allDiscrepancies: Discrepancy[] = [];

    const sourceRecords = source.records || [];
    const destRecords = destination.records || [];

    const sourceKeys = sourceRecords.map((r) => String(r.id || (r as any)._id));
    const destKeys = destRecords.map((r) => String(r.id || (r as any)._id || (r as any).source_id));

    const sourceOrders = source.orders || sourceRecords.flatMap((r) => r.orders || []);
    const destOrders = destination.orders || destRecords.flatMap((r) => r.orders || []);

    const sourceAttachments =
      source.attachments || sourceRecords.flatMap((r) => r.attachments || []);
    const destAttachments =
      destination.attachments || destRecords.flatMap((r) => r.attachments || []);

    const enable = this.config.enableChecks || {};

    // 1. Record count reconciliation
    if (enable.count !== false) {
      const countVal = new CountValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
      });
      const res = countVal.validate(sourceRecords.length, destRecords.length, 'customers');
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 2. Missing record detection
    if (enable.missing !== false) {
      const missingVal = new MissingRecordValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
      });
      const res = missingVal.validate(sourceKeys, new Set(destKeys));
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 3. Unexpected / extra record detection
    if (enable.extra !== false) {
      const extraVal = new ExtraRecordValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
      });
      const res = extraVal.validate(destKeys, new Set(sourceKeys));
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 4. Duplicate record detection
    if (enable.duplicate !== false) {
      const dupVal = new DuplicateValidator({
        migrationRunId,
        validationRunId,
        destinationObject: destination.objectName || 'customers',
      });
      const res = dupVal.validate(destRecords);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 5. Attachment presence & checksum verification
    if (enable.attachment !== false && (sourceAttachments.length > 0 || destAttachments.length > 0)) {
      const attVal = new AttachmentValidator({
        migrationRunId,
        validationRunId,
        sourceObject: 'attachments',
        destinationObject: 'attachments',
      });
      const res = attVal.validate(sourceAttachments, destAttachments);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 6. Parent-child relationship integrity
    if (enable.relationship !== false && (destOrders.length > 0 || sourceOrders.length > 0)) {
      const relVal = new RelationshipValidator({
        migrationRunId,
        validationRunId,
        parentObject: destination.objectName || 'customers',
        childObject: 'orders',
        parentKeyField: 'id',
        childForeignKeyField: 'customerId',
      });
      const res = relVal.validate(destRecords, destOrders);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 7. Metadata comparison
    if (enable.metadata !== false) {
      const metaVal = new MetadataValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
        attributesToCompare: this.config.metadataAttributes,
      });
      const res = metaVal.validate(sourceRecords, destRecords);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 8. Field-level comparison and type validation
    if (enable.field !== false && this.config.fieldRules && this.config.fieldRules.length > 0) {
      const fieldVal = new FieldValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
        rules: this.config.fieldRules,
      });
      const res = fieldVal.validate(sourceRecords, destRecords);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    // 9. Content hash verification over canonicalized representations
    if (enable.hash !== false) {
      const hashVal = new HashValidator({
        migrationRunId,
        validationRunId,
        sourceObject: source.objectName || 'customers',
        destinationObject: destination.objectName || 'customers',
        canonicalOptions: {
          excludeFields: [
            'orders',
            'attachments',
            'address',
            'extractedAt',
            '_injectedIssueId',
            '_defectId',
            '_faultDetails',
            'runId',
            'run_id',
          ],
        },
      });
      const res = hashVal.validate(sourceRecords, destRecords);
      checkResults.push(res);
      allDiscrepancies.push(...res.discrepancies);
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    let passedChecks = 0;
    let failedChecks = 0;
    let skippedChecks = 0;

    for (const r of checkResults) {
      if (r.state === 'PASS') passedChecks++;
      else if (r.state === 'FAIL') failedChecks++;
      else if (r.state === 'SKIPPED') skippedChecks++;
    }

    const overallState: ValidationCheckState = failedChecks > 0 ? 'FAIL' : 'PASS';

    const discrepanciesBySeverity: Record<DiscrepancySeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    const discrepanciesByCategory: Record<string, number> = {};

    for (const disc of allDiscrepancies) {
      discrepanciesBySeverity[disc.severity] =
        (discrepanciesBySeverity[disc.severity] || 0) + 1;
      discrepanciesByCategory[disc.category] =
        (discrepanciesByCategory[disc.category] || 0) + 1;
    }

    return {
      validationRunId,
      migrationRunId,
      workspaceId,
      overallState,
      startedAt,
      completedAt,
      durationMs,
      totalChecks: checkResults.length,
      passedChecks,
      failedChecks,
      skippedChecks,
      totalDiscrepancies: allDiscrepancies.length,
      discrepanciesBySeverity,
      discrepanciesByCategory,
      checkResults,
      discrepancies: allDiscrepancies,
    };
  }
}
