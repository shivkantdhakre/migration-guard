import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSyntheticDataset,
  injectFaults,
  ValidationEngine,
  generateDiscrepancyCsv,
  generateHtmlReport,
} from '../dist/index.js';

describe('MigrationGuard Fault Injection & Validation Engine (10k Dataset)', () => {
  it('should generate 10,000 reproducible customer records with deterministic seed', () => {
    const dataset1 = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });
    const dataset2 = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });

    assert.equal(dataset1.records.length, 10000);
    assert.equal(dataset2.records.length, 10000);
    assert.equal(dataset1.records[0].id, 'cust_000001');
    assert.equal(dataset1.records[0].email, dataset2.records[0].email);
    assert.ok(dataset1.orders && dataset1.orders.length > 10000);
    assert.ok(dataset1.attachments && dataset1.attachments.length > 1000);
  });

  it('should pass cleanly with 0 discrepancies on uncorrupted dataset', async () => {
    const cleanDataset = generateSyntheticDataset({ totalRecords: 1000, seed: 42 });
    const destinationCopy = JSON.parse(JSON.stringify(cleanDataset));

    const engine = new ValidationEngine({
      migrationRunId: 'MIG-CLEAN-001',
      validationRunId: 'VAL-CLEAN-001',
      enableChecks: {
        count: true,
        missing: true,
        extra: true,
        duplicate: true,
        hash: false,
        attachment: true,
        relationship: true,
        metadata: true,
      },
    });

    const summary = await engine.validate(cleanDataset, destinationCopy);

    assert.equal(summary.overallState, 'PASS');
    assert.equal(summary.totalDiscrepancies, 0);
    assert.equal(summary.failedChecks, 0);
    assert.equal(summary.discrepancies.length, 0);
  });

  it('should inject EXACTLY 45 seeded discrepancies across 4 target categories', () => {
    const dataset = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });
    const { faultedDataset, seededFaults } = injectFaults(dataset);

    assert.equal(seededFaults.length, 45);

    const missingAtt = seededFaults.filter((f) => f.category === 'MISSING_ATTACHMENT');
    const duplicates = seededFaults.filter((f) => f.category === 'DUPLICATE_RECORD');
    const brokenRefs = seededFaults.filter((f) => f.category === 'BROKEN_REFERENCE');
    const metaMismatches = seededFaults.filter((f) => f.category === 'METADATA_MISMATCH');

    assert.equal(missingAtt.length, 15);
    assert.equal(duplicates.length, 10);
    assert.equal(brokenRefs.length, 8);
    assert.equal(metaMismatches.length, 12);

    assert.deepEqual(
      missingAtt.map((f) => f.issueId),
      Array.from({ length: 15 }, (_, i) => `INJ-ATT-${String(i + 1).padStart(3, '0')}`)
    );
    assert.deepEqual(
      duplicates.map((f) => f.issueId),
      Array.from({ length: 10 }, (_, i) => `INJ-DUP-${String(i + 1).padStart(3, '0')}`)
    );
    assert.deepEqual(
      brokenRefs.map((f) => f.issueId),
      Array.from({ length: 8 }, (_, i) => `INJ-REF-${String(i + 1).padStart(3, '0')}`)
    );
    assert.deepEqual(
      metaMismatches.map((f) => f.issueId),
      Array.from({ length: 12 }, (_, i) => `INJ-MET-${String(i + 1).padStart(3, '0')}`)
    );
  });

  it('should detect ALL 45 injected discrepancies by ID with ZERO false positives', async () => {
    const cleanDataset = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });
    const { faultedDataset, seededFaults } = injectFaults(cleanDataset);

    const engine = new ValidationEngine({
      migrationRunId: 'MIG-RUN-FAULT-INJECTION-001',
      validationRunId: 'VAL-RUN-FAULT-INJECTION-001',
      enableChecks: {
        count: false,
        missing: false,
        extra: false,
        hash: false,
        field: false,
        attachment: true,
        duplicate: true,
        relationship: true,
        metadata: true,
      },
    });

    const summary = await engine.validate(cleanDataset, faultedDataset);

    // 1. Overall validation state must be FAIL
    assert.equal(summary.overallState, 'FAIL');

    // 2. Total discrepancies detected must be EXACTLY 45
    assert.equal(summary.totalDiscrepancies, 45);
    assert.equal(summary.discrepancies.length, 45);

    // 3. Category count assertions
    assert.equal(summary.discrepanciesByCategory['MISSING_ATTACHMENT'], 15);
    assert.equal(summary.discrepanciesByCategory['DUPLICATE_RECORD'], 10);
    assert.equal(summary.discrepanciesByCategory['BROKEN_REFERENCE'], 8);
    assert.equal(summary.discrepanciesByCategory['METADATA_MISMATCH'], 12);

    // 4. Verify exact detection of every injected defect by ID
    const detectedIssueIds = new Set(summary.discrepancies.map((d) => d.issueId));
    const expectedIssueIds = seededFaults.map((f) => f.issueId);

    for (const expectedId of expectedIssueIds) {
      assert.ok(
        detectedIssueIds.has(expectedId),
        `Expected seeded discrepancy ${expectedId} to be detected`
      );
    }

    // 5. Zero false positives: no extra unexpected discrepancies
    const falsePositives = summary.discrepancies.filter(
      (d) => !expectedIssueIds.includes(d.issueId)
    );
    assert.equal(falsePositives.length, 0);

    // 6. Verify Discrepancy output model structure compliance
    for (const disc of summary.discrepancies) {
      assert.ok(disc.issueId);
      assert.equal(disc.migrationRunId, 'MIG-RUN-FAULT-INJECTION-001');
      assert.equal(disc.validationRunId, 'VAL-RUN-FAULT-INJECTION-001');
      assert.ok(disc.category);
      assert.ok(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(disc.severity));
      assert.notEqual(disc.expectedValue, undefined);
      assert.notEqual(disc.actualValue, undefined);
      assert.ok(disc.explanation);
      assert.match(disc.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('should generate valid CSV and HTML validation reports containing all 45 discrepancies', async () => {
    const cleanDataset = generateSyntheticDataset({ totalRecords: 2000, seed: 1337 });
    const { faultedDataset } = injectFaults(cleanDataset);

    const engine = new ValidationEngine({
      migrationRunId: 'MIG-RUN-REPORT-TEST-001',
      validationRunId: 'VAL-RUN-REPORT-TEST-001',
      enableChecks: {
        count: false,
        missing: false,
        extra: false,
        hash: false,
        field: false,
        attachment: true,
        duplicate: true,
        relationship: true,
        metadata: true,
      },
    });

    const summary = await engine.validate(cleanDataset, faultedDataset);

    // Generate CSV
    const csv = generateDiscrepancyCsv(summary);
    assert.ok(csv.includes('issueId,validationRunId,migrationRunId,category,severity'));
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 46); // 1 header row + 45 discrepancy rows
    assert.ok(csv.includes('INJ-ATT-001'));
    assert.ok(csv.includes('INJ-DUP-001'));
    assert.ok(csv.includes('INJ-REF-001'));
    assert.ok(csv.includes('INJ-MET-001'));

    // Generate HTML
    const html = generateHtmlReport(summary, {
      title: 'Fault Injection Quality Assurance Report',
      projectName: 'Synthetic 10k E2E Test',
    });
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('MigrationGuard'));
    assert.ok(html.includes('VERDICT: DISCREPANCIES DETECTED'));
    assert.ok(html.includes('MISSING_ATTACHMENT'));
    assert.ok(html.includes('DUPLICATE_RECORD'));
    assert.ok(html.includes('BROKEN_REFERENCE'));
    assert.ok(html.includes('METADATA_MISMATCH'));
    assert.ok(html.includes('INJ-ATT-001'));
    assert.ok(html.includes('INJ-MET-012'));
  });
});
