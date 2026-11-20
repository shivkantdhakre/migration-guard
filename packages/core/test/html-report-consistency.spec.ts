import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHtmlReport } from '../dist/reports/html-report.js';

describe('HTML Report Automated Consistency & Audit Verification (P1.6)', () => {
  const baseSummary: any = {
    validationRunId: 'val-test-001',
    migrationRunId: 'run-uuid-12345',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 15,
    overallState: 'PASS',
    totalChecks: 1,
    passedChecks: 1,
    failedChecks: 0,
    skippedChecks: 0,
    totalDiscrepancies: 0,
    discrepanciesBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    discrepanciesByCategory: {},
    checkResults: [
      {
        checkId: 'CHECK-COUNT-001',
        checkName: 'Record Count Reconciliation',
        category: 'RECORD_COUNT_MISMATCH',
        state: 'PASS',
        evaluatedCount: 200,
        passedCount: 200,
        failedCount: 0,
        skippedCount: 0,
        durationMs: 2,
        discrepancies: [],
      },
    ],
    discrepancies: [],
  };

  it('fails report generation when migrationRunId is missing or empty', () => {
    const invalidSummary = { ...baseSummary, migrationRunId: '' };
    assert.throws(
      () => generateHtmlReport(invalidSummary),
      /Automated Consistency Error: summary\.migrationRunId is missing or empty/,
    );
  });

  it('fails report generation when expectedMigrationRunId mismatches summary.migrationRunId', () => {
    assert.throws(
      () =>
        generateHtmlReport(baseSummary, {
          expectedMigrationRunId: 'different-migration-uuid',
        }),
      /Automated Consistency Error: Migration run ID mismatch/,
    );
  });

  it('renders report with correct migrationRunId and optional runLabel', () => {
    const html = generateHtmlReport(baseSummary, {
      expectedMigrationRunId: 'run-uuid-12345',
      runLabel: 'MG-API-WORKER-E2E-20261121-005',
    });

    assert.equal(html.includes('run-uuid-12345'), true);
    assert.equal(html.includes('MG-API-WORKER-E2E-20261121-005'), true);
    assert.equal(html.includes('run-default-001'), false);
    assert.equal(html.includes('Cryptographically Verified Report'), false);
    assert.equal(html.includes('Deterministic Validation Guarantee'), true);
  });
});
