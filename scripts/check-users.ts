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
  const users = await pool.query('SELECT id, email, name FROM users LIMIT 5');
  console.log('Users:', users.rows);
  const workspaces = await pool.query('SELECT id, name, slug FROM workspaces LIMIT 5');
  console.log('Workspaces:', workspaces.rows);
  const projects = await pool.query('SELECT id, name, workspace_id FROM projects LIMIT 5');
  console.log('Projects:', projects.rows);
  await pool.end();
}

main().catch(console.error);
