/**
 * Core domain types for MigrationGuard
 */

// --- Workspace & IAM ---
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER' | 'OPERATOR';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

// --- Projects ---
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// --- Connections ---
export type DatabaseEngine = 'MONGODB' | 'POSTGRESQL';
export type ConnectionRole = 'SOURCE' | 'DESTINATION';
export type ConnectionStatus = 'UNTESTED' | 'HEALTHY' | 'UNHEALTHY' | 'DISCONNECTED';

export interface MongoConnectionConfig {
  host: string;
  port: number;
  database: string;
  authDatabase?: string;
  tls?: boolean;
  replicaSet?: string;
  readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
  options?: Record<string, unknown>;
}

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  schema?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  maxConnections?: number;
  options?: Record<string, unknown>;
}

export type ConnectionConfig = MongoConnectionConfig | PostgresConnectionConfig;

export interface Connection {
  id: string;
  workspaceId: string;
  name: string;
  engine: DatabaseEngine;
  connectionRole: ConnectionRole;
  config: ConnectionConfig;
  secretRef?: string;
  credentialVersion: number;
  status: ConnectionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// --- Schema & Snapshots ---
export interface FieldSchema {
  name: string;
  path: string;
  dataType: string;
  nativeType?: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyRef?: {
    targetTable: string;
    targetColumn: string;
  };
  defaultValue?: unknown;
  comment?: string;
  typeDistribution?: Record<string, number>; // BSON polymorphic distribution
}

export interface ConstraintDefinition {
  name: string;
  type: 'PRIMARY_KEY' | 'FOREIGN_KEY' | 'UNIQUE' | 'CHECK' | 'NOT_NULL';
  columns: string[];
  referenceTable?: string;
  referenceColumns?: string[];
  checkCondition?: string;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary?: boolean;
  indexType?: string;
}

export interface ObjectSchema {
  name: string;
  schema?: string; // Postgres schema e.g. "public"
  type: 'COLLECTION' | 'TABLE' | 'VIEW';
  fields: FieldSchema[];
  constraints?: ConstraintDefinition[];
  indexes?: IndexDefinition[];
  recordCountEstimate?: number;
}

export interface SchemaSnapshot {
  id: string;
  workspaceId: string;
  connectionId: string;
  connectionVersion: number;
  schemaVersion: number;
  engine: DatabaseEngine;
  objects: ObjectSchema[];
  discoveryMetadata: {
    discoveredAt: string;
    samplingMethod: 'FULL' | 'BOUNDED_SAMPLE';
    sampleSize?: number;
    durationMs: number;
  };
  createdAt: string;
}

// --- Data Profiling ---
export interface PatternObservation {
  patternName: string;
  regex: string;
  matchCount: number;
  matchPercentage: number;
}

export interface FieldProfile {
  path: string;
  totalEvaluated: number;
  nullCount: number;
  nullPercentage: number;
  distinctCountEstimate: number;
  emptyStringCount?: number;
  typeDistribution: Record<string, number>;
  min?: unknown;
  max?: unknown;
  avgLength?: number;
  patterns?: PatternObservation[];
  warnings?: string[];
}

export interface ObjectProfile {
  objectName: string;
  schema?: string;
  totalRecordsSampled: number;
  fields: Record<string, FieldProfile>;
  warnings: string[];
  profiledAt: string;
}

export interface ProfileResult {
  runId: string;
  connectionId: string;
  snapshotId?: string;
  objectProfiles: ObjectProfile[];
  profiledAt: string;
  sampleSize: number;
  durationMs: number;
}

export interface ProfileOptions {
  objects?: string[];
  sampleSize?: number;
  detectPatterns?: boolean;
  fields?: string[];
}

// --- Mapping DSL ---
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

export interface RenameTransform {
  op: 'RENAME';
  newName?: string;
}

export interface TrimStringTransform {
  op: 'TRIM_STRING';
  mode?: 'both' | 'left' | 'right';
}

export interface LowercaseTransform {
  op: 'LOWERCASE';
}

export interface UppercaseTransform {
  op: 'UPPERCASE';
}

export interface ParseIntegerTransform {
  op: 'PARSE_INTEGER';
  radix?: number;
  strict?: boolean;
  fallback?: number;
}

export interface ParseDecimalTransform {
  op: 'PARSE_DECIMAL';
  precision?: number;
  scale?: number;
  roundingMode?: 'HALF_UP' | 'FLOOR' | 'CEIL' | 'DOWN';
  strict?: boolean;
}

export interface ParseTimestampTransform {
  op: 'PARSE_TIMESTAMP';
  format?: 'AUTO_ISO_OR_EPOCH' | 'ISO8601' | 'EPOCH_MS' | 'EPOCH_SEC' | string;
  timezone?: string;
}

export interface ToJsonbTransform {
  op: 'TO_JSONB';
  pretty?: boolean;
}

export interface FlattenObjectTransform {
  op: 'FLATTEN_OBJECT';
  delimiter?: string;
  maxDepth?: number;
}

export interface ArrayToChildRowsTransform {
  op: 'ARRAY_TO_CHILD_ROWS';
  childTable: string;
  parentKeyCol: string;
  itemCol?: string;
  itemKeyCol?: string;
  preserveIndexCol?: string;
}

export interface SetDefaultTransform {
  op: 'SET_DEFAULT';
  value: unknown;
}

export interface NullIfEmptyTransform {
  op: 'NULL_IF_EMPTY';
  emptyStrings?: boolean;
  emptyObjects?: boolean;
  emptyArrays?: boolean;
}

export interface PreserveSourceIdTransform {
  op: 'PRESERVE_SOURCE_ID';
  targetColumn?: string;
  format?: 'string' | 'hex' | 'raw';
}

export type TransformConfig =
  | RenameTransform
  | TrimStringTransform
  | LowercaseTransform
  | UppercaseTransform
  | ParseIntegerTransform
  | ParseDecimalTransform
  | ParseTimestampTransform
  | ToJsonbTransform
  | FlattenObjectTransform
  | ArrayToChildRowsTransform
  | SetDefaultTransform
  | NullIfEmptyTransform
  | PreserveSourceIdTransform;

export type IdentityStrategy =
  | 'PRESERVE_AS_TEXT'
  | 'PRESERVE_ORIGINAL'
  | 'MAP_TO_UUID'
  | 'HASH_SHA256'
  | 'CUSTOM';

export interface IdentityMapping {
  sourceKey: string;
  destinationKey: string;
  strategy: IdentityStrategy;
}

export interface FieldMapping {
  sourcePath: string;
  destinationPath: string;
  transform?: TransformConfig | TransformConfig[];
  nullable?: boolean;
  defaultValue?: unknown;
}

export interface ObjectMapping {
  source: {
    collection: string;
  };
  destination: {
    schema?: string;
    table: string;
  };
  identity: IdentityMapping;
  fields: FieldMapping[];
}

export interface MappingDefinition {
  version: number;
  name?: string;
  description?: string;
  objects: ObjectMapping[];
}

export interface MappingVersion {
  id: string;
  workspaceId: string;
  planId?: string;
  version: number;
  mapping: MappingDefinition;
  mappingHash: string;
  createdBy: string;
  createdAt: string;
}

// --- Plan, Dry-Run, Approval ---
export type WriteMode = 'INSERT_ONLY' | 'UPSERT' | 'SKIP_EXISTING';

export interface ExecutionConfig {
  batchSize: number;
  concurrency: number;
  writeMode: WriteMode;
  conflictColumns?: string[];
  updateColumns?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface ValidationProfile {
  checks: string[];
  severityThreshold?: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  sampleValidation?: {
    enabled: boolean;
    samplePercent?: number;
  };
}

export interface MigrationPlanVersion {
  id: string;
  planId: string;
  version: number;
  sourceConnectionId: string;
  sourceSchemaSnapshotId: string;
  destinationConnectionId: string;
  destinationSchemaSnapshotId: string;
  mappingVersionId: string;
  scope: {
    objects: string[];
  };
  executionConfig: ExecutionConfig;
  validationProfile: ValidationProfile;
  planHash: string;
  createdBy: string;
  createdAt: string;
}

// --- Envelopes & Cursors ---
export interface AttachmentReference {
  id: string;
  key: string;
  fieldPath: string;
  fileName?: string;
  contentType?: string;
  byteSize: number;
  sha256Hash: string;
  storageRef?: string;
}

export interface SourceCursor {
  lastId?: unknown;
  sortValue?: unknown;
  cursorValues?: Record<string, unknown>;
  isExhausted: boolean;
  recordsReadSoFar?: number;
}

export interface SourceRecordEnvelope {
  sourceObject: string;
  sourceKey: string;
  sourceVersion?: string;
  sourceCursor?: SourceCursor;
  payload: Record<string, unknown>;
  extractedAt: string;
  attachmentRefs?: AttachmentReference[];
}

export interface ChildRow {
  destinationTable: string;
  parentKey: string;
  parentKeyCol: string;
  payload: Record<string, unknown>;
  sourceIndex?: number;
}

export interface TransformedRecord {
  destinationObject: string;
  destinationKey: string;
  sourceObject: string;
  sourceKey: string;
  payload: Record<string, unknown>;
  childRows?: ChildRow[];
  canonicalHash: string;
  warnings?: string[];
}

export interface TransformedBatch {
  batchKey: string;
  sequenceNo: number;
  records: TransformedRecord[];
  childBatches?: Record<string, ChildRow[]>;
}

// --- Manifests, Checkpoints, ID Mappings ---
export type BatchStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMMITTED'
  | 'RETRY_WAIT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'OUTCOME_UNKNOWN';

export interface MigrationBatch {
  id: string;
  migrationRunId: string;
  batchKey: string;
  sequenceNo: number;
  status: BatchStatus;
  sourceCursorStart?: Record<string, unknown>;
  sourceCursorEnd?: Record<string, unknown>;
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  attemptCount: number;
  startedAt?: string;
  completedAt?: string;
  errorSummary?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
}

export interface RecordManifest {
  id: string;
  migrationRunId: string;
  batchId: string;
  sourceObject: string;
  sourceKey: string;
  sourceKeyHash: string;
  destinationKey: string;
  contentHash: string;
  outcome: 'COMMITTED' | 'SKIPPED' | 'FAILED';
  createdAt: string;
}

export interface IdMapping {
  id: string;
  migrationRunId: string;
  sourceObject: string;
  sourceKey: string;
  destinationObject: string;
  destinationKey: string;
  createdAt: string;
}

export interface Checkpoint {
  migrationRunId: string;
  sourceObject: string;
  lastCommittedSequenceNo: number;
  sourceCursor: SourceCursor;
  totalRecordsCommitted: number;
  checkpointTimestamp: string;
}

// --- Validation & Discrepancies ---
export type DiscrepancyCategory =
  | 'COUNT_MISMATCH'
  | 'MISSING_RECORD'
  | 'EXTRA_RECORD'
  | 'DUPLICATE_RECORD'
  | 'CONTENT_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'RELATIONSHIP_BROKEN'
  | 'ATTACHMENT_MISMATCH'
  | 'METADATA_MISMATCH';

export type DiscrepancySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'WARNING';

export interface Discrepancy {
  id: string;
  validationRunId: string;
  migrationBatchId?: string;
  category: DiscrepancyCategory;
  severity: DiscrepancySeverity;
  sourceObject: string;
  sourceKeyRef?: string;
  destinationObject: string;
  destinationKeyRef?: string;
  fieldPath?: string;
  expectedValue?: unknown;
  actualValue?: unknown;
  evidenceRef?: string;
  summary: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'ACCEPTED_RISK';
  createdAt: string;
  updatedAt: string;
}

export type ValidationCheckState = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_APPLICABLE' | 'ERROR';

export interface ValidationCheckResult {
  checkId: string;
  checkName: string;
  status: ValidationCheckState;
  evaluatedCount: number;
  passCount: number;
  failCount: number;
  skippedCount: number;
  durationMs: number;
  evidenceRef?: string;
  message?: string;
}

export interface ValidationSummary {
  validationRunId: string;
  migrationRunId: string;
  status: 'PASSED' | 'FAILED' | 'COMPLETED_WITH_WARNINGS';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
  totalDiscrepancies: number;
  discrepanciesByCategory: Record<DiscrepancyCategory, number>;
  discrepanciesBySeverity: Record<DiscrepancySeverity, number>;
  startedAt: string;
  completedAt: string;
}
