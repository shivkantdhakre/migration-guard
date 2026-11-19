import { describe, expect, it } from 'vitest';
import { ErrorClassifier } from '../src/engine/error-classifier.js';

describe('Error Classifier (FR-REC-002, 08_MIGRATION_ENGINE_DESIGN)', () => {
  describe('Retryable Errors', () => {
    it('classifies PostgreSQL deadlock and serialization failure as RETRYABLE', () => {
      const deadlockErr = { code: '40P01', message: 'deadlock detected' };
      const res1 = ErrorClassifier.classify(deadlockErr);
      expect(res1.classification).toBe('RETRYABLE');
      expect(res1.isRetryable).toBe(true);
      expect(res1.requiresReconciliation).toBe(false);

      const serialErr = { code: '40001', message: 'could not serialize access due to concurrent update' };
      const res2 = ErrorClassifier.classify(serialErr);
      expect(res2.classification).toBe('RETRYABLE');
    });

    it('classifies transient network codes (ETIMEDOUT, ECONNRESET, ECONNREFUSED) as RETRYABLE before write', () => {
      const timeoutErr = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 127.0.0.1:5432' };
      const res = ErrorClassifier.classify(timeoutErr, 'READ_STARTED');
      expect(res.classification).toBe('RETRYABLE');
      expect(res.isRetryable).toBe(true);
    });

    it('classifies rate limiting and connection pool exhaustion as RETRYABLE', () => {
      const rateLimitErr = new Error('Too Many Requests: 429 rate limit exceeded');
      expect(ErrorClassifier.classify(rateLimitErr).classification).toBe('RETRYABLE');

      const poolErr = { code: '53300', message: 'too many connections' };
      expect(ErrorClassifier.classify(poolErr).classification).toBe('RETRYABLE');
    });
  });

  describe('Permanent Errors', () => {
    it('classifies NOT NULL constraint violations (23502) as PERMANENT', () => {
      const err = { code: '23502', message: 'null value in column "name" violates not-null constraint' };
      const res = ErrorClassifier.classify(err);
      expect(res.classification).toBe('PERMANENT');
      expect(res.isRetryable).toBe(false);
      expect(res.requiresReconciliation).toBe(false);
    });

    it('classifies Foreign Key violations (23503) as PERMANENT', () => {
      const err = { code: '23503', message: 'insert or update on table "orders" violates foreign key constraint' };
      const res = ErrorClassifier.classify(err);
      expect(res.classification).toBe('PERMANENT');
      expect(res.isRetryable).toBe(false);
    });

    it('classifies missing tables/columns (42P01, 42703) as PERMANENT schema mismatches', () => {
      const tableErr = { code: '42P01', message: 'relation "non_existent_table" does not exist' };
      expect(ErrorClassifier.classify(tableErr).classification).toBe('PERMANENT');

      const colErr = { code: '42703', message: 'column "unknown_col" does not exist' };
      expect(ErrorClassifier.classify(colErr).classification).toBe('PERMANENT');
    });

    it('classifies permission and auth errors as PERMANENT', () => {
      const authErr = { code: '28P01', message: 'password authentication failed' };
      expect(ErrorClassifier.classify(authErr).classification).toBe('PERMANENT');

      const permErr = { code: '42501', message: 'permission denied for table customers' };
      expect(ErrorClassifier.classify(permErr).classification).toBe('PERMANENT');
    });

    it('classifies invalid mapping or unsupported transform as PERMANENT', () => {
      const err = new Error('Unsupported transformation: UNKNOWN_OPERATION');
      expect(ErrorClassifier.classify(err).classification).toBe('PERMANENT');
    });
  });

  describe('Outcome Unknown Errors (Reconciliation Required)', () => {
    it('classifies network drop or socket hangup during WRITE_STARTED as OUTCOME_UNKNOWN', () => {
      const socketDropErr = {
        code: 'ECONNRESET',
        message: 'socket hang up while writing batch',
      };
      const res = ErrorClassifier.classify(socketDropErr, 'WRITE_STARTED');
      expect(res.classification).toBe('OUTCOME_UNKNOWN');
      expect(res.isRetryable).toBe(false);
      expect(res.requiresReconciliation).toBe(true);
    });

    it('classifies query cancellation/statement timeout during destination write as OUTCOME_UNKNOWN', () => {
      const timeoutErr = {
        code: '57014',
        message: 'canceling statement due to statement timeout during destination write commit',
      };
      const res = ErrorClassifier.classify(timeoutErr, 'WRITE_STARTED');
      expect(res.classification).toBe('OUTCOME_UNKNOWN');
      expect(res.requiresReconciliation).toBe(true);
    });
  });
});
