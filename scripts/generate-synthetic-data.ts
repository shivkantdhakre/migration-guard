/**
 * CLI script to generate reproducible synthetic customer dataset.
 * MigrationGuard · 10,000 records with customer profiles, embedded orders, metadata, attachments.
 */
import { generateSyntheticDataset } from '../packages/core/dist/index.js';

function main() {
  console.log('Generating 10,000 synthetic records with seed 1337...');
  const start = Date.now();
  const dataset = generateSyntheticDataset({ totalRecords: 10000, seed: 1337 });
  const duration = Date.now() - start;

  console.log(`Generated in ${duration}ms:`);
  console.log(`- Total Customers: ${dataset.records.length.toLocaleString()}`);
  console.log(`- Total Orders: ${(dataset.orders?.length || 0).toLocaleString()}`);
  console.log(`- Total Attachments: ${(dataset.attachments?.length || 0).toLocaleString()}`);

  const sampleCust = dataset.records[0];
  console.log('\nSample Customer Record (first):');
  console.log(JSON.stringify({
    id: sampleCust.id,
    name: sampleCust.name,
    email: sampleCust.email,
    ordersCount: sampleCust.orders?.length,
    attachmentsCount: sampleCust.attachments?.length,
    metadata: sampleCust.metadata,
  }, null, 2));
}

main();
