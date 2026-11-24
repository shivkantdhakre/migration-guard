// Domain Types for MigrationGuard Infrastructure Platform

export type EngineType = 'MONGODB' | 'POSTGRESQL';
export type ConnectionRole = 'SOURCE' | 'DESTINATION';
export type ConnectionStatus = 'UNTESTED' | 'ACTIVE' | 'DEGRADED' | 'FAILED';

export interface DatabaseConnection {
  id: string;
  name: string;
  engine: EngineType;
  connectionRole: ConnectionRole;
  status: ConnectionStatus;
  credentialVersion: number;
  config: {
    host: string;
    port: number;
    database: string;
    tls: boolean;
    authDatabase?: string;
    schema?: string;
  };
  lastTestedAt?: string;
  latencyMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyTarget?: string;
  sampleValues?: any[];
  unique?: boolean;
  nullPercentage?: number;
}

export interface CollectionSchema {
  name: string;
  documentCount: number;
  avgDocSizeBytes: number;
  fields: SchemaField[];
}

export interface TableSchema {
  name: string;
  rowCount: number;
  columns: SchemaField[];
}

export interface SchemaSnapshot {
  id: string;
  connectionId: string;
  capturedAt: string;
  engine: EngineType;
  collections?: CollectionSchema[];
  tables?: TableSchema[];
}

export type TransformOp =
  | 'RENAME'
  | 'TRIM_STRING'
  | 'LOWERCASE'
  | 'UPPERCASE'
  | 'PARSE_INTEGER'
  | 'PARSE_DECIMAL'
  | 'PARSE_TIMESTAMP'
  | 'TO_JSONB'
  | 'FLATTEN_OBJECT'
  | 'ARRAY_TO_CHILD_ROWS'
  | 'SET_DEFAULT'
  | 'NULL_IF_EMPTY'
  | 'PRESERVE_SOURCE_ID';

export interface FieldMapping {
  id: string;
  sourcePath: string;
  sourceType: string;
  destinationPath: string;
  destinationType: string;
  transform: {
    op: TransformOp;
    format?: string;
    defaultValue?: any;
  };
  notes?: string;
  confidence?: number;
  aiSuggested?: boolean;
}

export interface ObjectMapping {
  sourceCollection: string;
  destinationTable: string;
  identity: {
    sourceKey: string;
    destinationKey: string;
    strategy: 'PRESERVE_AS_TEXT' | 'UUID_V5_FROM_OID' | 'SURROGATE_BIGINT';
  };
  fieldMappings: FieldMapping[];
}

export interface MappingVersion {
  id: string;
  versionNumber: number;
  name: string;
  createdAt: string;
  objects: ObjectMapping[];
  validationStatus: 'VALID' | 'WARNINGS' | 'INVALID';
  validationErrors?: string[];
}

export type PlanStatus = 'DRAFT' | 'READY' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';

export interface PlanVersionSummary {
  id: string;
  version: number;
  planHash: string;
  sourceConnectionId?: string;
  destinationConnectionId?: string;
  status?: string;
  createdAt?: string;
}

export interface DryRunFactMetrics {
  sampleRecordsTested: number;
  recordsTransformed: number;
  transformationErrors: number;
  measuredDurationMs: number;
  measuredRatePerSec: number;
}

export interface DryRunProjectedEstimates {
  projectedBatchDurationMs: number;
  projectedThroughputPerSec: number;
}

export interface DryRunTestedObject {
  sourceObject: string;
  destinationObject: string;
  sampleCount: number;
  transformedCount: number;
  errors: number;
  conflicts: any[];
}

export interface DryRunResult {
  id: string;
  planVersionId: string;
  workspaceId?: string;
  planHash: string;
  status: 'COMPLETED' | 'FAILED';
  measuredFacts: DryRunFactMetrics;
  projectedEstimates?: DryRunProjectedEstimates;
  sampleRecordsTested: number;
  recordsTransformed: number;
  transformationErrors: number;
  potentialTypeConflicts: Array<{
    sourceObject?: string;
    destinationObject?: string;
    sourcePath?: string;
    destinationColumn?: string;
    reason?: string;
    severity?: string;
  }>;
  objectsTested: DryRunTestedObject[];
  readyForApproval: boolean;
  executedAt: string;
}

export interface MigrationPlan {
  id: string;
  versionId?: string;
  name: string;
  sourceConnectionId: string;
  destinationConnectionId: string;
  mappingVersionId: string;
  status: PlanStatus;
  batchSize: number;
  concurrency: number;
  writeMode: 'INSERT_ONLY' | 'UPSERT_ON_KEY';
  planHash: string; // sha256:...
  approvalComment?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  versions?: PlanVersionSummary[];
}

export type RunStatus =
  | 'DRAFT'
  | 'READY'
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSING'
  | 'PAUSED'
  | 'MIGRATED'
  | 'COMPLETED'
  | 'VALIDATING'
  | 'VALIDATED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NEEDS_ATTENTION';

export interface MigrationRun {
  id: string;
  planId: string;
  planHash: string;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
  totalRecords: number;
  processedRecords: number;
  succeededRecords: number;
  failedRecords: number;
  skippedRecords: number;
  throughputPerSecond: number;
  currentCollection?: string;
  activeBatchId?: string;
  validationStatus?: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED_DISCREPANCIES';
  createdAt: string;
}

export type BatchStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMMITTED'
  | 'RETRY_WAIT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'OUTCOME_UNKNOWN'
  | 'SKIPPED'
  | 'CANCELLED';

export interface MigrationBatch {
  id: string;
  runId: string;
  batchIndex: number;
  collectionName: string;
  cursorStart: string;
  cursorEnd: string;
  status: BatchStatus;
  recordsCount: number;
  writtenCount: number;
  failedCount: number;
  retryAttempt: number;
  latencyMs: number;
  startedAt?: string;
  committedAt?: string;
  errorMessage?: string;
}

export type DiscrepancyCategory =
  | 'MISSING_RECORD'
  | 'EXTRA_RECORD'
  | 'DUPLICATE_RECORD'
  | 'CONTENT_MISMATCH'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_CHECKSUM_MISMATCH'
  | 'BROKEN_REFERENCE'
  | 'METADATA_MISMATCH'
  | 'TYPE_CONVERSION_ERROR'
  | 'VALIDATION_SKIPPED';

export type DiscrepancySeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface DiscrepancyRecord {
  id: string;
  runId: string;
  validationRunId: string;
  sourceKey: string;
  destinationKey: string;
  category: DiscrepancyCategory;
  severity: DiscrepancySeverity;
  collectionOrTable: string;
  fieldOrPath?: string;
  expectedValue: any;
  actualValue: any;
  explanation: string;
  status: 'UNRESOLVED' | 'INVESTIGATING' | 'ACKNOWLEDGED' | 'REPAIRED';
  createdAt: string;
}

export interface ValidationCheck {
  id: string;
  name: string;
  category: DiscrepancyCategory;
  status: 'PASS' | 'FAIL' | 'WARNING' | 'SKIPPED';
  recordsTested: number;
  discrepanciesFound: number;
  durationMs: number;
  details: string;
}

export interface ValidationRun {
  id: string;
  migrationRunId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  startedAt: string;
  completedAt?: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  totalDiscrepancies: number;
  checks: ValidationCheck[];
}

export interface CopilotMessage {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
  timestamp: string;
  evidenceRefs?: {
    type: 'DISCREPANCY' | 'BATCH' | 'SCHEMA' | 'MAPPING' | 'RUN';
    id: string;
    label: string;
  }[];
  proposal?: {
    id: string;
    title: string;
    actionType: 'RETRY_FAILED_BATCH' | 'UPDATE_MAPPING_RULE' | 'REVALIDATE_SCOPE' | 'ISOLATE_RECORDS';
    summary: string;
    safePreview: string;
    status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  };
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: string;
  timestamp: string;
  ipAddress: string;
  immutableHash: string;
}
