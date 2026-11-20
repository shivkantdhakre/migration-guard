import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore
import pg from '../packages/backend/node_modules/pg/lib/index.js';

function loadEnv() {
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'packages/backend/.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const k = trimmed.substring(0, eq).trim();
          let v = trimmed.substring(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.substring(1, v.length - 1);
          }
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    }
  }
}
loadEnv();

const RUN_LABEL = 'MG-E2E-20261120-001';
const RUN_UUID = '36988c91-405c-41fe-9919-e01377cf0033';

async function main() {
  const pgUrl = process.env.DATABASE_URL;
  if (!pgUrl) throw new Error('DATABASE_URL not set');

  const pool = new pg.Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  
  console.log('=== 1. DESTINATION ROW COUNTS (WHERE run_id = $1) ===');
  const custCount = await pool.query('SELECT COUNT(*) FROM customers WHERE run_id = $1', [RUN_LABEL]);
  const ordCount = await pool.query('SELECT COUNT(*) FROM orders WHERE run_id = $1', [RUN_LABEL]);
  const attCount = await pool.query('SELECT COUNT(*) FROM customer_attachments WHERE run_id = $1', [RUN_LABEL]);
  console.log({
    customers: custCount.rows[0].count,
    orders: ordCount.rows[0].count,
    customer_attachments: attCount.rows[0].count,
  });

  console.log('\n=== 2. REFERENTIAL INTEGRITY (ORPHANED RECORDS) ===');
  const orphOrd = await pool.query(`
    SELECT COUNT(*) FROM orders o 
    LEFT JOIN customers c ON o.customer_id = c.id 
    WHERE o.run_id = $1 AND c.id IS NULL
  `, [RUN_LABEL]);
  const orphAtt = await pool.query(`
    SELECT COUNT(*) FROM customer_attachments a 
    LEFT JOIN customers c ON a.customer_id = c.id 
    WHERE a.run_id = $1 AND c.id IS NULL
  `, [RUN_LABEL]);
  console.log({
    orphaned_orders: orphOrd.rows[0].count,
    orphaned_attachments: orphAtt.rows[0].count,
  });

  console.log('\n=== 3. DUPLICATE CHECK ON PRIMARY KEYS ===');
  const dups = await pool.query(`
    SELECT id, COUNT(*) FROM customers WHERE run_id = $1 GROUP BY id HAVING COUNT(*) > 1
  `, [RUN_LABEL]);
  console.log({ duplicateCustomerKeys: dups.rows.length });

  console.log('\n=== 4. MIGRATION RUN RECORD (WHERE id = $1 UUID) ===');
  const runRec = await pool.query(
    'SELECT id, status, started_at, completed_at, source_boundary_json, progress_json FROM migration_runs WHERE id = $1',
    [RUN_UUID]
  );
  console.log(runRec.rows[0]);

  console.log('\n=== 5. ALL 15 MIGRATION BATCHES (WHERE migration_run_id = $1 UUID) ===');
  const batches = await pool.query(
    'SELECT batch_key, sequence_no, status, records_read, records_written, started_at, completed_at FROM migration_batches WHERE migration_run_id = $1 ORDER BY sequence_no ASC',
    [RUN_UUID]
  );
  console.table(batches.rows);

  console.log('\n=== 6. RECORD MANIFESTS SUMMARY (WHERE migration_run_id = $1 UUID) ===');
  const manifests = await pool.query(
    'SELECT source_object, status, COUNT(*) as count FROM record_manifests WHERE migration_run_id = $1 GROUP BY source_object, status ORDER BY source_object ASC',
    [RUN_UUID]
  );
  console.table(manifests.rows);

  console.log('\n=== 7. VALIDATION RUN RECORD (WHERE migration_run_id = $1 UUID) ===');
  const valRun = await pool.query(
    'SELECT id, status, started_at, completed_at, summary_json FROM validation_runs WHERE migration_run_id = $1',
    [RUN_UUID]
  );
  if (valRun.rows[0]) {
    const summary = typeof valRun.rows[0].summary_json === 'string'
      ? JSON.parse(valRun.rows[0].summary_json)
      : valRun.rows[0].summary_json;
    console.log({
      id: valRun.rows[0].id,
      status: valRun.rows[0].status,
      started_at: valRun.rows[0].started_at,
      completed_at: valRun.rows[0].completed_at,
      overallState: summary.overallState,
      totalChecks: summary.totalChecks,
      passedChecks: summary.passedChecks,
      failedChecks: summary.failedChecks,
      totalDiscrepancies: summary.totalDiscrepancies,
    });
  } else {
    console.log('No validation run found for this UUID');
  }

  await pool.end();
}

main().catch(console.error);
