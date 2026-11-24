/**
 * Error Classifier for MigrationGuard Data Plane
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 08_MIGRATION_ENGINE_DESIGN.md (Section 8), 10_TEST_STRATEGY.md
 *
 * Distinguishes:
 * - RETRYABLE: Temporary network issues before known commit, rate limits, temporary DB unavailability, safe deadlocks/serialization failures.
 * - PERMANENT: Data type conversion errors, constraint violations, missing required fields, schema mismatches, auth/permission failures.
 * - OUTCOME_UNKNOWN: Network drops or timeouts during/after destination write commit where write status is ambiguous.
 */

import { BatchSubStage, ErrorClassification, ErrorSummary } from '../types.js';

export interface ClassifiedError {
  classification: ErrorClassification;
  code: string;
  message: string;
  isRetryable: boolean;
  requiresReconciliation: boolean;
  originalError: unknown;
  subStage?: BatchSubStage;
}

// Known PostgreSQL Error Codes
const PG_RETRYABLE_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const PG_PERMANENT_CODES = new Set([
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '23514', // check_violation
  '22001', // string_data_right_truncation
  '22003', // numeric_value_out_of_range
  '22007', // invalid_datetime_format
  '22008', // datetime_field_overflow
  '22P02', // invalid_text_representation
  '42P01', // undefined_table
  '42703', // undefined_column
  '42P07', // duplicate_table
  '42804', // datatype_mismatch
  '28P01', // invalid_password
  '42501', // insufficient_privilege
]);

// Known System / Network Error Codes
const NETWORK_RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export class ErrorClassifier {
  /**
   * Classifies an error into RETRYABLE, PERMANENT, or OUTCOME_UNKNOWN
   */
  public static classify(error: unknown, subStage?: BatchSubStage): ClassifiedError {
    const errorObj = (typeof error === 'object' && error !== null) ? (error as Record<string, unknown>) : {};

    // If already pre-classified, preserve or refine classification
    if (errorObj.classified && typeof errorObj.classified === 'object') {
      const pre = errorObj.classified as ClassifiedError;
      if (pre.classification && pre.code) {
        return {
          ...pre,
          subStage: subStage || pre.subStage,
          originalError: errorObj.originalError || pre.originalError || error,
        };
      }
    }

    const underlying = (typeof errorObj.originalError === 'object' && errorObj.originalError !== null)
      ? (errorObj.originalError as Record<string, unknown>)
      : errorObj;

    const message = (typeof errorObj.message === 'string' && errorObj.message)
      ? errorObj.message
      : (typeof underlying.message === 'string' && underlying.message)
        ? underlying.message
        : String(error);

    const code = (typeof errorObj.code === 'string' && errorObj.code !== 'UNKNOWN_ERROR')
      ? errorObj.code
      : (typeof underlying.code === 'string' && underlying.code !== 'UNKNOWN_ERROR')
        ? underlying.code
        : (typeof errorObj.sqlState === 'string'
          ? errorObj.sqlState
          : (typeof underlying.sqlState === 'string' ? underlying.sqlState : 'UNKNOWN_ERROR'));

    // 1. Check for OUTCOME_UNKNOWN conditions:
    // If failure happened during destination write (subStage === 'WRITE_STARTED' or 'DESTINATION_WRITTEN')
    // and network disconnected or timed out, the destination commit status is ambiguous.
    const isWriteInFlight = subStage === 'WRITE_STARTED';
    const isNetworkError = NETWORK_RETRYABLE_CODES.has(code) ||
      code === '08006' ||
      code === '08000' ||
      code === '08001' ||
      code === '08004' ||
      message.includes('socket hang up') ||
      message.includes('connection reset') ||
      message.includes('connection failure') ||
      message.includes('timeout') ||
      message.includes('EPIPE') ||
      code === 'EPIPE' ||
      code === '57014'; // query_canceled / statement_timeout during write

    if (isWriteInFlight && isNetworkError) {
      return {
        classification: 'OUTCOME_UNKNOWN',
        code: code || 'OUTCOME_UNKNOWN',
        message: `Destination write outcome unknown: ${message}`,
        isRetryable: false,
        requiresReconciliation: true,
        originalError: error,
        subStage,
      };
    }

    // 2. Check for explicit permanent database/data errors
    if (PG_PERMANENT_CODES.has(code) || code === 'COLLISION_DETECTED' || code === 'EMPTY_DESTINATION_PAYLOAD') {
      return {
        classification: 'PERMANENT',
        code,
        message,
        isRetryable: false,
        requiresReconciliation: false,
        originalError: error,
        subStage,
      };
    }

    // Explicit permanent message patterns
    const lowerMessage = message.toLowerCase();
    if (
      lowerMessage.includes('violates not-null constraint') ||
      lowerMessage.includes('violates foreign key constraint') ||
      lowerMessage.includes('violates unique constraint') ||
      lowerMessage.includes('collision detected') ||
      lowerMessage.includes('empty destination payload') ||
      lowerMessage.includes('syntax error') ||
      lowerMessage.includes('relation does not exist') ||
      lowerMessage.includes('column does not exist') ||
      lowerMessage.includes('unsupported transformation') ||
      lowerMessage.includes('invalid mapping') ||
      lowerMessage.includes('record size exceeded') ||
      lowerMessage.includes('permission denied') ||
      lowerMessage.includes('authentication failed')
    ) {
      return {
        classification: 'PERMANENT',
        code: code !== 'UNKNOWN_ERROR' ? code : 'PERMANENT_DATA_ERROR',
        message,
        isRetryable: false,
        requiresReconciliation: false,
        originalError: error,
        subStage,
      };
    }

    // 3. Check for retryable database codes
    if (PG_RETRYABLE_CODES.has(code)) {
      return {
        classification: 'RETRYABLE',
        code,
        message,
        isRetryable: true,
        requiresReconciliation: false,
        originalError: error,
        subStage,
      };
    }

    // 4. Check for retryable network / connection errors
    if (NETWORK_RETRYABLE_CODES.has(code) ||
        lowerMessage.includes('connection refused') ||
        lowerMessage.includes('connection reset') ||
        lowerMessage.includes('network error') ||
        lowerMessage.includes('deadlock') ||
        lowerMessage.includes('lock wait timeout') ||
        lowerMessage.includes('too many connections') ||
        lowerMessage.includes('rate limit') ||
        lowerMessage.includes('429')) {
      return {
        classification: 'RETRYABLE',
        code: code !== 'UNKNOWN_ERROR' ? code : 'TRANSIENT_NETWORK_ERROR',
        message,
        isRetryable: true,
        requiresReconciliation: false,
        originalError: error,
        subStage,
      };
    }

    // Default to PERMANENT for unclassified errors to avoid infinite retry loops
    return {
      classification: 'PERMANENT',
      code: code || 'UNCLASSIFIED_ERROR',
      message: `Unclassified error: ${message}`,
      isRetryable: false,
      requiresReconciliation: false,
      originalError: error,
      subStage,
    };
  }

  public static toErrorSummary(classified: ClassifiedError, retryCount = 0): ErrorSummary {
    return {
      code: classified.code,
      message: classified.message,
      classification: classified.classification,
      retryCount,
      timestamp: new Date().toISOString(),
      stack: classified.originalError instanceof Error ? classified.originalError.stack : undefined,
    };
  }

  public static isRetryable(error: unknown, subStage?: BatchSubStage): boolean {
    return this.classify(error, subStage).isRetryable;
  }

  public static requiresReconciliation(error: unknown, subStage?: BatchSubStage): boolean {
    return this.classify(error, subStage).requiresReconciliation;
  }
}
