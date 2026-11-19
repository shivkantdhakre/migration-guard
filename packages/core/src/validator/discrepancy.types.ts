/**
 * Discrepancy and Validation Output Models for MigrationGuard.
 * Compliant with 08_MIGRATION_ENGINE_DESIGN.md and 05_DATA_MODEL.md.
 */

export type DiscrepancyCategory =
  | 'MISSING_ATTACHMENT'
  | 'DUPLICATE_RECORD'
  | 'BROKEN_REFERENCE'
  | 'METADATA_MISMATCH'
  | 'RECORD_COUNT_MISMATCH'
  | 'MISSING_RECORD'
  | 'EXTRA_RECORD'
  | 'CONTENT_HASH_MISMATCH'
  | 'FIELD_VALUE_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'NULLABILITY_MISMATCH';

export type DiscrepancySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type DiscrepancyStatus =
  | 'OPEN'
  | 'INVESTIGATING'
  | 'RESOLVED'
  | 'ACCEPTED_RISK'
  | 'WONT_FIX';

export type ValidationCheckState =
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED'
  | 'NOT_APPLICABLE'
  | 'ERROR';

export interface Discrepancy {
  /** Unique issue identifier (UUID or deterministic seeded key) */
  issueId: string;
  /** Migration run identifier */
  migrationRunId: string;
  /** Validation run identifier */
  validationRunId: string;
  /** Primary identifier in source database/collection */
  sourceKey: string | null;
  /** Primary identifier in destination database/table */
  destinationKey: string | null;
  /** Discrepancy classification category */
  category: DiscrepancyCategory;
  /** Severity level */
  severity: DiscrepancySeverity;
  /** Expected value or description of expected state */
  expectedValue: unknown;
  /** Actual value or description of observed state */
  actualValue: unknown;
  /** Detailed human- and machine-readable explanation */
  explanation: string;
  /** ISO-8601 timestamp when discrepancy was detected */
  timestamp: string;
  /** Workflow investigation status */
  status?: DiscrepancyStatus;
  /** Field path or attribute where mismatch occurred (if applicable) */
  fieldPath?: string;
  /** Source collection/entity name */
  sourceObject?: string;
  /** Destination table/entity name */
  destinationObject?: string;
  /** Reference to evidentiary payload or hash */
  evidenceRef?: string;
  /** Additional diagnostic metadata */
  metadata?: Record<string, unknown>;
}

export interface ValidationCheckResult {
  checkId: string;
  checkName: string;
  category: DiscrepancyCategory | string;
  state: ValidationCheckState;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  discrepancies: Discrepancy[];
  details?: Record<string, unknown>;
}

export interface ValidationRunSummary {
  validationRunId: string;
  migrationRunId: string;
  workspaceId?: string;
  overallState: ValidationCheckState;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
  totalDiscrepancies: number;
  discrepanciesBySeverity: Record<DiscrepancySeverity, number>;
  discrepanciesByCategory: Record<string, number>;
  checkResults: ValidationCheckResult[];
  discrepancies: Discrepancy[];
}

export interface AttachmentItem {
  attachmentId: string;
  recordId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string; // SHA-256
  storageKey?: string;
}

export interface CustomerOrder {
  orderId: string;
  customerId: string;
  totalAmount: number | string;
  currency: string;
  orderDate: string;
  status: 'PENDING' | 'COMPLETED' | 'SHIPPED' | 'CANCELLED';
  itemsCount: number;
}

export interface CustomerRecord {
  id: string; // source _id or mapped target id
  name: string;
  email: string;
  address?: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  createdAt: string;
  updatedAt: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tier: 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
  metadata: {
    accountManager?: string;
    segment?: string;
    tags?: string[];
    creditScore?: number;
    preferences?: Record<string, unknown>;
    customFlags?: Record<string, unknown>;
    [key: string]: unknown;
  };
  orders?: CustomerOrder[];
  attachments?: AttachmentItem[];
  [key: string]: unknown;
}

export interface ValidationDataset {
  objectName: string;
  records: CustomerRecord[];
  orders?: CustomerOrder[];
  attachments?: AttachmentItem[];
}
