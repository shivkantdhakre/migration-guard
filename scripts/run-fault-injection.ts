/**
 * Fault Injection Scenario Runner
 * Proves exact detection of all 45 injected discrepancies without false positives.
 */
import {
  generateSyntheticDataset,
  injectFaults,
  ValidationEngine,
  generateDiscrepancyCsv,
  generateHtmlReport,
} from '../packages/core/dist/index.js';

async function main() {
  console.log('=== MigrationGuard Fault Injection Validation Scenario ===\n');

  console.log('1. Generating clean synthetic source dataset (10,000 records)...');
  const cleanDataset = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });
  console.log(`   Customers: ${cleanDataset.records.length}, Orders: ${cleanDataset.orders?.length}, Attachments: ${cleanDataset.attachments?.length}`);

  console.log('\n2. Injecting EXACTLY 45 controlled faults into destination dataset:');
  console.log('   - 15 Missing Attachments');
  console.log('   - 10 Duplicate Records');
  console.log('   - 8 Broken References');
  console.log('   - 12 Metadata Mismatches');
  const { faultedDataset, seededFaults } = injectFaults(cleanDataset);
  console.log(`   Total Seeded Faults: ${seededFaults.length}`);

  console.log('\n3. Running Deterministic Validation Engine...');
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

  console.log(`\n4. Validation Run Completed in ${summary.durationMs}ms`);
  console.log(`   Overall State: ${summary.overallState}`);
  console.log(`   Total Discrepancies Detected: ${summary.totalDiscrepancies}`);
  console.log('   Discrepancies by Category:');
  for (const [cat, count] of Object.entries(summary.discrepanciesByCategory)) {
    console.log(`     - ${cat}: ${count}`);
  }

  // Verification
  console.log('\n5. Verifying Exact Match with Seeded Faults:');
  const detectedIssueIds = new Set(summary.discrepancies.map((d) => d.issueId));
  const seededIssueIds = new Set(seededFaults.map((f) => f.issueId));

  let matched = 0;
  for (const seededId of seededIssueIds) {
    if (detectedIssueIds.has(seededId)) {
      matched++;
    } else {
      console.error(`   MISSING: Seeded defect ${seededId} was NOT detected!`);
    }
  }

  const falsePositives = summary.discrepancies.filter((d) => !seededIssueIds.has(d.issueId));

  console.log(`   Matched Defects: ${matched} / ${seededFaults.length}`);
  console.log(`   False Positives: ${falsePositives.length}`);

  if (matched === 45 && falsePositives.length === 0 && summary.totalDiscrepancies === 45) {
    console.log('\n SUCCESS: All 45 seeded discrepancies detected with 0 false positives!\n');
  } else {
    console.error('\n FAILURE: Discrepancy mismatch detected!\n');
    process.exit(1);
  }

  // Generate Reports
  const csv = generateDiscrepancyCsv(summary);
  const html = generateHtmlReport(summary);
  console.log(`CSV Report generated (${csv.length} bytes)`);
  console.log(`HTML Report generated (${html.length} bytes)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
