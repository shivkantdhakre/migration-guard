/**
 * MigrationGuard Worker Domain Types and Interfaces
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 05_DATA_MODEL.md, 08_MIGRATION_ENGINE_DESIGN.md
 */

export interface AttachmentReference {
  fieldPath: string;
  sourceKey: string;
  destinationKey?: string;
  fileName: string;
  contentType?: string;
  byteSize?: number;
  checksumSha256?: string;
  storagePath?: string;
}

export interface SourceRecordEnvelope {
  sourceObject: string;
  sourceKey: string;
  sourceVersion?: string;
  sourceCursor?: Record<string, unknown>;
  payload: unknown;
  extractedAt: string;
  attachmentRefs?: AttachmentReference[];
}

export interface SourceCursor {
  lastId?: string | number | null;
  sortField?: string;
  sortValue?: unknown;
  offset?: number;
  filter?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

export interface SourceBatch {
  records: SourceRecordEnvelope[];
  nextCursor: SourceCursor | null;
  hasMore: boolean;
  stats?: {
    bytesRead?: number;
    recordsCount?: number;
  };
}

export interface TransformedRecord {
  destinationKey: string;
  sourceKey: string;
  sourceObject: string;
  destinationObject: string;
  data: Record<string, unknown>;
  originalEnvelope?: SourceRecordEnvelope;
  contentHash?: string;
}

export interface TransformedBatch {
  destinationObject: string;
  records: TransformedRecord[];
  batchKey: string;
}

export type WriteMode = 'insert_only' | 'upsert' | 'skip_existing';

export interface WriteOptions {
  writeMode: WriteMode;
  conflictColumns?: string[];
  updateColumns?: string[];
}

export interface WriteResult {
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  writtenKeys: string[];
  skippedKeys: string[];
  failedKeys: Array<{ key: string; error: string; code?: string }>;
  durationMs: number;
}

export interface DestinationRecord {
  destinationKey: string;
  data: Record<string, unknown>;
}

export interface ReadBatchOptions {
  sourceObject: string;
  batchSize: number;
  maxBytes?: number;
  sortField?: string;
}

export interface SourceConnector {
  testConnection(): Promise<{ success: boolean; latencyMs: number; message?: string }>;
  readBatch(cursor: SourceCursor | null, options: ReadBatchOptions): Promise<SourceBatch>;
  close(): Promise<void>;
}

export interface DestinationConnector {
  testConnection(): Promise<{ success: boolean; latencyMs: number; message?: string }>;
  writeBatch(batch: TransformedBatch, options: WriteOptions): Promise<WriteResult>;
  readByKeys(destinationObject: string, keys: string[]): Promise<DestinationRecord[]>;
  close(): Promise<void>;
}

/**
 * Exact Batch States required by specification:
 * PENDING, QUEUED, RUNNING, COMMITTED, RETRY_WAIT, FAILED_RETRYABLE, FAILED_PERMANENT, OUTCOME_UNKNOWN
 */
export type BatchStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMMITTED'
  | 'RETRY_WAIT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'OUTCOME_UNKNOWN';

/**
 * Intermediate execution sub-stages for crash recovery
 */
export type BatchSubStage =
  | 'IDLE'
  | 'READ_STARTED'
  | 'READ_COMPLETED'
  | 'TRANSFORM_STARTED'
  | 'TRANSFORM_COMPLETED'
  | 'WRITE_STARTED'
  | 'DESTINATION_WRITTEN'
  | 'MANIFEST_COMMITTED'
  | 'CHECKPOINT_COMMITTED';

export type ErrorClassification = 'RETRYABLE' | 'PERMANENT' | 'OUTCOME_UNKNOWN';

export interface ErrorSummary {
  code?: string;
  message: string;
  classification: ErrorClassification;
  retryCount?: number;
  timestamp: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface MigrationBatch {
  id: string;
  migrationRunId: string;
  batchKey: string;
  sequenceNo: number;
  status: BatchStatus;
  subStage?: BatchSubStage;
  sourceObject: string;
  destinationObject: string;
  sourceCursorStart: SourceCursor | null;
  sourceCursorEnd: SourceCursor | null;
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  attemptCount: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string;
  errorSummary?: ErrorSummary;
}

export interface RecordManifest {
  id: string;
  migrationRunId: string;
  batchKey: string;
  sourceObject: string;
  sourceKey: string;
  destinationObject: string;
  destinationKey: string;
  contentHash?: string;
  status: 'WRITTEN' | 'SKIPPED' | 'FAILED';
  error?: string;
  createdAt: string;
}

export interface IdMappingRecord {
  id: string;
  migrationRunId: string;
  sourceObject: string;
  sourceKey: string;
  destinationObject: string;
  destinationKey: string;
  createdAt: string;
}

export interface MigrationCheckpoint {
  migrationRunId: string;
  sourceObject: string;
  lastCommittedSequenceNo: number;
  lastCommittedBatchKey: string;
  lastCommittedCursor: SourceCursor | null;
  planVersionId: string;
  mappingVersionId: string;
  totalRecordsCommitted: number;
  updatedAt: string;
}

/**
 * BullMQ / Redis Queue Payload
 * CRITICAL RULE: Queue payloads carry IDs and cursors only, NEVER bulk records!
 */
export interface MigrationJobPayload {
  jobId: string;
  migrationRunId: string;
  batchKey: string;
  sequenceNo: number;
  sourceObject: string;
  destinationObject: string;
  cursorStart: SourceCursor | null;
  cursorEnd?: SourceCursor | null;
  batchSize: number;
  maxBytes?: number;
  planVersionId: string;
  mappingVersionId: string;
  writeMode: WriteMode;
  conflictColumns?: string[];
  updateColumns?: string[];
}

export type MigrationRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';

export interface MigrationRunProgress {
  migrationRunId: string;
  status: MigrationRunStatus;
  batchesTotal: number;
  batchesCommitted: number;
  batchesFailed: number;
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  throughputRecordsPerSec: number;
  activeBatchKey?: string;
  lastCommittedSequenceNo: number;
  startedAt?: string;
  completedAt?: string;
}

export type TransformFunction = (
  envelope: SourceRecordEnvelope,
) => Promise<TransformedRecord | null> | TransformedRecord | null;
