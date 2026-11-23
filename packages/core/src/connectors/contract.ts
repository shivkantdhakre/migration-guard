import {
  DatabaseEngine,
  SchemaSnapshot,
  ProfileOptions,
  ProfileResult,
  SourceRecordEnvelope,
  SourceCursor,
  TransformedBatch,
  WriteMode,
} from '../types/index.js';

export interface ConnectionTestResult {
  healthy: boolean;
  message: string;
  latencyMs: number;
  serverVersion?: string;
  capabilities: {
    canStream: boolean;
    supportsTransactions: boolean;
    supportsTls: boolean;
    supportedTypes: string[];
    [key: string]: unknown;
  };
  testedAt: string;
}

export interface DiscoveryOptions {
  databases?: string[];
  schemas?: string[];
  objects?: string[];
  sampleSize?: number;
  includeIndexes?: boolean;
  includeConstraints?: boolean;
}

export interface ReadBatchOptions {
  objectName: string;
  batchSize: number;
  maxBytes?: number;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
  filter?: Record<string, unknown>;
  projection?: string[];
}

export interface SourceBatch {
  batchKey: string;
  records: SourceRecordEnvelope[];
  nextCursor?: SourceCursor;
  hasMore: boolean;
  totalRecordsEstimate?: number;
  bytesRead: number;
}

export interface WriteOptions {
  mode: WriteMode; // 'INSERT_ONLY' | 'UPSERT' | 'SKIP_EXISTING'
  conflictColumns?: string[];
  updateColumns?: string[];
  timeoutMs?: number;
}

export interface WriteResult {
  recordsWritten: number;
  recordsUpdated: number;
  recordsSkipped: number;
  recordsFailed: number;
  durationMs: number;
  errors?: Array<{ key: string; error: string; retryable: boolean }>;
}

export interface StableKey {
  key: string;
  value: unknown;
}

export interface DestinationRecord {
  destinationKey: string;
  data: Record<string, unknown>;
  found: boolean;
}

export type ConnectorErrorCode =
  | 'CONNECTION_FAILED'
  | 'QUERY_TIMEOUT'
  | 'DEADLOCK_DETECTED'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_FAILED'
  | 'SCHEMA_MISMATCH'
  | 'CONSTRAINT_VIOLATION'
  | 'OVERSIZED_RECORD'
  | 'PERMISSION_DENIED'
  | 'OUTCOME_UNKNOWN';

export class ConnectorError extends Error {
  public readonly code: ConnectorErrorCode;
  public readonly retryable: boolean;
  public readonly isUnknownOutcome: boolean;
  public readonly details?: unknown;

  constructor(params: {
    message: string;
    code: ConnectorErrorCode;
    retryable: boolean;
    isUnknownOutcome?: boolean;
    details?: unknown;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'ConnectorError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.isUnknownOutcome = params.isUnknownOutcome ?? false;
    this.details = params.details;
    if (params.cause) {
      this.cause = params.cause;
    }
  }
}

export interface SourceConnector {
  readonly engine: DatabaseEngine;
  testConnection(): Promise<ConnectionTestResult>;
  discoverSchema(options?: DiscoveryOptions): Promise<SchemaSnapshot>;
  profile(options: ProfileOptions): Promise<ProfileResult>;
  readBatch(cursor?: SourceCursor, options?: ReadBatchOptions): Promise<SourceBatch>;
  count(objectName: string, filter?: Record<string, unknown>): Promise<number>;
  close(): Promise<void>;
}

export interface DestinationConnector {
  readonly engine: DatabaseEngine;
  testConnection(): Promise<ConnectionTestResult>;
  inspectSchema(options?: DiscoveryOptions): Promise<SchemaSnapshot>;
  writeBatch(batch: TransformedBatch, options: WriteOptions): Promise<WriteResult>;
  readByKeys(objectName: string, keys: StableKey[], keyColumn?: string): Promise<DestinationRecord[]>;
  count(objectName: string): Promise<number>;
  close(): Promise<void>;
}
