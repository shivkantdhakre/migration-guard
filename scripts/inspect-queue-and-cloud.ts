import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import { MongoClient } from '../packages/worker/node_modules/mongodb/lib/index.js';
// @ts-ignore
import { Redis } from '../packages/worker/node_modules/ioredis/built/index.js';
// @ts-ignore
import * as bullmq from '../packages/worker/node_modules/bullmq/dist/cjs/index.js';
const { Queue } = bullmq as any;
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
  console.log('--- 1. Inspecting BullMQ Queue on Aiven Valkey ---');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL missing');
    return;
  }
  const redisParsed = new URL(redisUrl);
  const redis = new Redis({
    host: redisParsed.hostname,
    port: parseInt(redisParsed.port || '15678', 10),
    username: redisParsed.username || 'default',
    password: redisParsed.password,
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });

  const ping = await redis.ping();
  console.log('Redis PING:', ping);

  const queue = new Queue('migration-execution', { connection: redis });

  const waitingCount = await queue.getWaitingCount();
  const activeCount = await queue.getActiveCount();
  const completedCount = await queue.getCompletedCount();
  const failedCount = await queue.getFailedCount();
  const delayedCount = await queue.getDelayedCount();

  console.log(`Queue Counts: waiting=${waitingCount}, active=${activeCount}, completed=${completedCount}, failed=${failedCount}, delayed=${delayedCount}`);

  const waitingJobs = await queue.getWaiting(0, 50);
  console.log(`Waiting jobs (${waitingJobs.length}):`);
  for (const j of waitingJobs) {
    console.log(`  - ID: ${j.id}, Name: ${j.name}, runId: ${j.data?.migrationRunId}, batchKey: ${j.data?.batchKey}`);
  }

  const completedJobs = await queue.getCompleted(0, 50);
  console.log(`Completed jobs (${completedJobs.length}):`);
  for (const j of completedJobs) {
    console.log(`  - ID: ${j.id}, Name: ${j.name}, runId: ${j.data?.migrationRunId}`);
  }

  console.log('\n--- 2. Inspecting MongoDB Atlas ---');
  const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (mongoUrl) {
    const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    await mongo.connect();
    const dbs = await mongo.db().admin().listDatabases();
    console.log('MongoDB databases:', dbs.databases.map((d: any) => d.name));
    
    // Check migrationguard_e2e_source
    const dbSource = mongo.db('migrationguard_e2e_source');
    const cols = await dbSource.listCollections().toArray();
    console.log('Collections in migrationguard_e2e_source:', cols.map((c: any) => c.name));
    for (const c of cols) {
      const count = await dbSource.collection(c.name).countDocuments();
      console.log(`  - ${c.name}: ${count} documents`);
    }
    await mongo.close();
  }

  console.log('\n--- 3. Inspecting PostgreSQL ---');
  const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const res = await pgPool.query("SELECT COUNT(*) FROM migration_runs");
  console.log(`Total migration_runs in PG: ${res.rows[0].count}`);
  const runs = await pgPool.query("SELECT id, status, started_at FROM migration_runs ORDER BY started_at DESC LIMIT 5");
  console.log('Recent migration_runs:', runs.rows);

  await queue.close();
  redis.disconnect();
  await pgPool.end();
}

main().catch(console.error);
