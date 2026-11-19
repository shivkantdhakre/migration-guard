import {
  AttachmentItem,
  CustomerOrder,
  CustomerRecord,
  DiscrepancyCategory,
  ValidationDataset,
} from './discrepancy.types.js';

export interface InjectedFaultDescriptor {
  issueId: string;
  category: DiscrepancyCategory;
  targetKey: string;
  fieldPath?: string;
  expectedValue: unknown;
  injectedValue: unknown;
  description: string;
}

export interface FaultInjectionResult {
  faultedDataset: ValidationDataset;
  seededFaults: InjectedFaultDescriptor[];
}

/**
 * Injects EXACTLY 45 seeded discrepancies into a dataset:
 * - 15 missing attachments
 * - 10 duplicate records
 * - 8 broken references
 * - 12 metadata mismatches
 * Total: 45 seeded discrepancies.
 */
export function injectFaults(cleanDataset: ValidationDataset): FaultInjectionResult {
  const seededFaults: InjectedFaultDescriptor[] = [];

  // Deep clone clean records, orders, attachments
  const clonedRecords: CustomerRecord[] = JSON.parse(JSON.stringify(cleanDataset.records));
  const clonedOrders: CustomerOrder[] = JSON.parse(JSON.stringify(cleanDataset.orders || []));
  const clonedAttachments: AttachmentItem[] = JSON.parse(
    JSON.stringify(cleanDataset.attachments || [])
  );

  // -------------------------------------------------------------
  // 1. EXACTLY 15 MISSING ATTACHMENTS
  // -------------------------------------------------------------
  const missingAttachmentCount = 15;
  if (clonedAttachments.length < missingAttachmentCount) {
    throw new Error(
      `Dataset has fewer than ${missingAttachmentCount} attachments (${clonedAttachments.length})`
    );
  }

  // Remove the first 15 attachments from destination dataset
  const removedAttachments = clonedAttachments.splice(0, missingAttachmentCount);
  const removedAttIdSet = new Set(removedAttachments.map((a) => a.attachmentId));

  // Also remove from clonedRecords' attachments arrays
  for (const rec of clonedRecords) {
    if (rec.attachments && rec.attachments.length > 0) {
      rec.attachments = rec.attachments.filter((a) => !removedAttIdSet.has(a.attachmentId));
    }
  }

  for (let i = 0; i < missingAttachmentCount; i++) {
    const att = removedAttachments[i];
    const issueId = `INJ-ATT-${String(i + 1).padStart(3, '0')}`;

    // Mark the source dataset attachment item with the injected issue ID
    const srcAtt = cleanDataset.attachments?.find((a) => a.attachmentId === att.attachmentId);
    if (srcAtt) {
      (srcAtt as any)._injectedIssueId = issueId;
    }
    for (const rec of cleanDataset.records) {
      const recAtt = rec.attachments?.find((a) => a.attachmentId === att.attachmentId);
      if (recAtt) {
        (recAtt as any)._injectedIssueId = issueId;
      }
    }

    seededFaults.push({
      issueId,
      category: 'MISSING_ATTACHMENT',
      targetKey: att.attachmentId,
      fieldPath: 'attachments',
      expectedValue: att.checksum,
      injectedValue: null,
      description: `Attachment ${att.fileName} (${att.attachmentId}) deleted from destination`,
    });
  }

  // -------------------------------------------------------------
  // 2. EXACTLY 10 DUPLICATE RECORDS
  // -------------------------------------------------------------
  const duplicateCount = 10;
  // Pick 10 records at distinct positions (e.g. indices 100, 200, 300, ...)
  for (let i = 0; i < duplicateCount; i++) {
    const originalIndex = (i + 1) * 100;
    const originalRecord = clonedRecords[originalIndex];
    const issueId = `INJ-DUP-${String(i + 1).padStart(3, '0')}`;

    // Create duplicate copy with same primary id
    const duplicateRecord: CustomerRecord = JSON.parse(JSON.stringify(originalRecord));
    (duplicateRecord as any)._injectedIssueId = issueId;
    (duplicateRecord as any)._defectId = issueId;
    (duplicateRecord as any)._faultDetails = { originalIndex, duplicatedKey: originalRecord.id };

    // Append duplicate record
    clonedRecords.push(duplicateRecord);

    seededFaults.push({
      issueId,
      category: 'DUPLICATE_RECORD',
      targetKey: originalRecord.id,
      fieldPath: 'id',
      expectedValue: 'Single unique occurrence',
      injectedValue: 'Duplicate occurrence appended to destination',
      description: `Duplicate record appended for customer ${originalRecord.id}`,
    });
  }

  // -------------------------------------------------------------
  // 3. EXACTLY 8 BROKEN REFERENCES
  // -------------------------------------------------------------
  const brokenRefCount = 8;
  // Pick 8 orders from child orders
  for (let i = 0; i < brokenRefCount; i++) {
    const orderIndex = (i + 1) * 75;
    const order = clonedOrders[orderIndex];
    const issueId = `INJ-REF-${String(i + 1).padStart(3, '0')}`;
    const originalCustomerId = order.customerId;
    const nonExistentCustomerId = `cust_BROKEN_NONEXISTENT_${String(i + 1).padStart(3, '0')}`;

    order.customerId = nonExistentCustomerId;
    (order as any)._injectedIssueId = issueId;

    seededFaults.push({
      issueId,
      category: 'BROKEN_REFERENCE',
      targetKey: order.orderId,
      fieldPath: 'customerId',
      expectedValue: originalCustomerId,
      injectedValue: nonExistentCustomerId,
      description: `Order ${order.orderId} customerId modified to point to non-existent parent ${nonExistentCustomerId}`,
    });
  }

  // -------------------------------------------------------------
  // 4. EXACTLY 12 METADATA MISMATCHES
  // -------------------------------------------------------------
  const metadataMismatchCount = 12;
  // Pick 12 records in upper half of dataset (well away from the duplicate records)
  const baseOffset = Math.floor(clonedRecords.length * 0.5);
  for (let i = 0; i < metadataMismatchCount; i++) {
    const recordIndex = Math.min(clonedRecords.length - 1, baseOffset + i * 15);
    const record = clonedRecords[recordIndex];
    const issueId = `INJ-MET-${String(i + 1).padStart(3, '0')}`;

    const originalCreditScore = record.metadata.creditScore;
    const corruptedCreditScore = 300 + i;

    record.metadata.creditScore = corruptedCreditScore;
    (record as any)._injectedIssueId = issueId;
    (record as any)._injectedMetadataFault = {
      issueId,
      attribute: 'creditScore',
      expectedValue: originalCreditScore,
      actualValue: corruptedCreditScore,
      explanation: `Customer credit score mismatch. Expected ${originalCreditScore}, but found ${corruptedCreditScore}`,
    };

    seededFaults.push({
      issueId,
      category: 'METADATA_MISMATCH',
      targetKey: record.id,
      fieldPath: 'metadata.creditScore',
      expectedValue: originalCreditScore,
      injectedValue: corruptedCreditScore,
      description: `Credit score modified from ${originalCreditScore} to ${corruptedCreditScore} on customer ${record.id}`,
    });
  }

  // Ensure total seeded faults is exactly 45
  if (seededFaults.length !== 45) {
    throw new Error(`Seeded fault count must be exactly 45, but was ${seededFaults.length}`);
  }

  const faultedDataset: ValidationDataset = {
    objectName: cleanDataset.objectName,
    records: clonedRecords,
    orders: clonedOrders,
    attachments: clonedAttachments,
  };

  return {
    faultedDataset,
    seededFaults,
  };
}
