import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function findRepoRoot(): string {
  let cur = process.cwd();
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}
const REPO_ROOT = findRepoRoot();

async function main() {
  const backendJsPath = path.resolve(REPO_ROOT, 'packages/backend/dist/main.js');
  console.log('Starting backend from:', backendJsPath);

  const backend = spawn('node', [backendJsPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '4001', ALLOW_IN_MEMORY_DB: 'false' },
    stdio: 'inherit',
  });

  await new Promise(r => setTimeout(r, 6000));

  const email = `test_${Date.now()}@migrationguard.io`;
  const regRes = await fetch('http://127.0.0.1:4001/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Tester', password: 'Password123!' }),
  });
  console.log('Register status:', regRes.status);
  const regJson = await regRes.json();
  console.log('Register response:', JSON.stringify(regJson, null, 2));

  backend.kill('SIGTERM');
  process.exit(0);
}

main().catch(console.error);
