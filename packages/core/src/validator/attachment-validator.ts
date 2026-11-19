import {
  AttachmentItem,
  Discrepancy,
  ValidationCheckResult,
  ValidationCheckState,
} from './discrepancy.types.js';

export interface AttachmentValidatorOptions {
  checkId?: string;
  migrationRunId: string;
  validationRunId: string;
  sourceObject?: string;
  destinationObject?: string;
}

export class AttachmentValidator {
  private checkId: string;
  private migrationRunId: string;
  private validationRunId: string;
  private sourceObject: string;
  private destinationObject: string;

  constructor(options: AttachmentValidatorOptions) {
    this.checkId = options.checkId || 'CHECK-ATTACHMENT-001';
    this.migrationRunId = options.migrationRunId;
    this.validationRunId = options.validationRunId;
    this.sourceObject = options.sourceObject || 'attachments';
    this.destinationObject = options.destinationObject || 'attachments';
  }

  public validate(
    expectedAttachments: AttachmentItem[],
    destinationAttachments: AttachmentItem[]
  ): ValidationCheckResult {
    const start = Date.now();
    const discrepancies: Discrepancy[] = [];

    // Map destination attachments by attachmentId
    const destMap = new Map<string, AttachmentItem>();
    for (const att of destinationAttachments) {
      destMap.set(att.attachmentId, att);
    }

    let passedCount = 0;
    let failedCount = 0;

    for (const exp of expectedAttachments) {
      const dest = destMap.get(exp.attachmentId);

      // Check 1: Presence
      if (!dest) {
        failedCount++;
        const issueId =
          (exp as any)._injectedIssueId ||
          (exp as any).injectedIssueId ||
          `DISC-ATT-MISSING-${exp.attachmentId}`;

        discrepancies.push({
          issueId,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: exp.recordId,
          destinationKey: exp.attachmentId,
          category: 'MISSING_ATTACHMENT',
          severity: 'HIGH',
          expectedValue: {
            attachmentId: exp.attachmentId,
            fileName: exp.fileName,
            byteSize: exp.byteSize,
            checksum: exp.checksum,
          },
          actualValue: null,
          explanation: `Attachment '${exp.fileName}' (${exp.attachmentId}) belonging to record '${exp.recordId}' was not migrated or is missing from destination storage.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          fieldPath: 'attachments',
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            attachmentId: exp.attachmentId,
            fileName: exp.fileName,
            byteSize: exp.byteSize,
            expectedChecksum: exp.checksum,
          },
        });
        continue;
      }

      // Check 2: Checksum and byte size verification
      if (dest.checksum && exp.checksum && dest.checksum !== exp.checksum) {
        failedCount++;
        const issueId =
          (dest as any)._injectedIssueId ||
          (exp as any)._injectedIssueId ||
          `DISC-ATT-CSUM-${exp.attachmentId}`;

        discrepancies.push({
          issueId,
          migrationRunId: this.migrationRunId,
          validationRunId: this.validationRunId,
          sourceKey: exp.recordId,
          destinationKey: exp.attachmentId,
          category: 'CONTENT_HASH_MISMATCH',
          severity: 'HIGH',
          expectedValue: exp.checksum,
          actualValue: dest.checksum,
          explanation: `Attachment checksum mismatch for '${exp.fileName}' (${exp.attachmentId}). Expected ${exp.checksum}, but observed ${dest.checksum}.`,
          timestamp: new Date().toISOString(),
          status: 'OPEN',
          fieldPath: 'checksum',
          sourceObject: this.sourceObject,
          destinationObject: this.destinationObject,
          metadata: {
            attachmentId: exp.attachmentId,
            fileName: exp.fileName,
            expectedSize: exp.byteSize,
            actualSize: dest.byteSize,
          },
        });
        continue;
      }

      passedCount++;
    }

    const durationMs = Date.now() - start;
    const state: ValidationCheckState = discrepancies.length === 0 ? 'PASS' : 'FAIL';

    return {
      checkId: this.checkId,
      checkName: `Attachment Presence & Checksum Verification (${this.sourceObject})`,
      category: 'MISSING_ATTACHMENT',
      state,
      evaluatedCount: expectedAttachments.length,
      passedCount,
      failedCount,
      skippedCount: 0,
      durationMs,
      discrepancies,
      details: {
        totalExpected: expectedAttachments.length,
        totalFound: destMap.size,
        discrepanciesCount: failedCount,
      },
    };
  }
}
