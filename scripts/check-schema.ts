import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import pg from '../packages/backend/node_modules/pg/lib/index.js';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
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
loadEnv();

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable 
    FROM information_schema.columns 
    WHERE table_name IN ('customers', 'orders', 'customer_attachments', 'migration_runs', 'migration_batches', 'record_manifests') 
    ORDER BY table_name, ordinal_position;
  `);
  
  const grouped: Record<string, any[]> = {};
  for (const row of cols.rows) {
    if (!grouped[row.table_name]) grouped[row.table_name] = [];
    grouped[row.table_name].push({ col: row.column_name, type: row.data_type, nullable: row.is_nullable });
  }

  console.log(JSON.stringify(grouped, null, 2));
  await pool.end();
}

main().catch(console.error);
