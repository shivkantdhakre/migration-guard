# MigrationGuard — Integration & Cloud Test Guide

**Date:** 20 November 2026  
**Audience:** Migration Engineers, QA Engineers, DevOps, Security Auditors  

---

## 1. Prerequisites & Environment Configuration

Ensure Node.js `>= 22.0.0` and `pnpm >= 9.0.0` are installed.

Create a `.env` file at the root of the project with the following environment variables (or ensure it is propagated to `packages/backend/.env`, `packages/worker/.env`, and `packages/frontend/.env.local`):

```bash
# PostgreSQL (Control Plane & Destination)
DATABASE_URL=postgresql://<pg-user>:<pg-password>@<pg-host>:5432/<pg-db>?sslmode=require
ALLOW_IN_MEMORY_DB=false

# Redis / Valkey (BullMQ Distributed Queue)
REDIS_URL=rediss://default:<valkey-password>@<valkey-host>:15678
REDIS_HOST=<valkey-host>
REDIS_PORT=15678
REDIS_PASSWORD=<valkey-password>
REDIS_TLS=true

# AI Provider (Google Gemini API)
GEMINI_API_KEY=<gemini-api-key>
GEMINI_MODEL=gemini-2.5-flash
AI_MODEL_NAME=gemini-2.5-flash

# S3 / MinIO Storage (Assurance Reports & Attachments)
S3_ENDPOINT=https://<s3-host>.storage.aws.neon.tech
S3_ACCESS_KEY=<s3-access-key>
S3_SECRET_KEY=<s3-secret-key>
S3_REGION=ap-southeast-1
S3_BUCKET=migrationguard-assurance-reports

# API & Security
JWT_SECRET=<jwt-secret-min-32-chars>
ENCRYPTION_MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PORT=4000
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_DEMO_MODE=false
```

---

## 2. Monorepo Build

Compile all four packages (`@migrationguard/core`, `@migrationguard/worker`, `@migrationguard/backend`, `@migrationguard/frontend`):

```bash
pnpm build
```

---

## 3. Running Backend Integration Tests (Control Plane)

The backend test suite verifies database persistence, tenant isolation, vault encryption, plan canonical hashing, BullMQ producer dispatching, validation engine integration, and AI safety guardrails against live Neon Cloud PostgreSQL and Aiven Valkey Redis:

```bash
# Run all 69 backend tests across 16 test files:
pnpm --filter @migrationguard/backend test

# Run specific backend test suites:
pnpm --filter @migrationguard/backend test test/auth.spec.ts
pnpm --filter @migrationguard/backend test test/connection-redaction.spec.ts
pnpm --filter @migrationguard/backend test test/plan-approval-hashing.spec.ts
pnpm --filter @migrationguard/backend test test/queue.spec.ts
pnpm --filter @migrationguard/backend test test/validation-report.spec.ts
```

---

## 4. Running Worker Tests (Data Plane)

The worker test suite verifies batch recovery, checkpointing, ID tracking, error classification, bounded memory streaming, and real destination PostgreSQL writes:

```bash
# Run all 41 worker tests across 11 test files:
pnpm --filter @migrationguard/worker test

# Run real PostgreSQL destination write test:
pnpm --filter @migrationguard/worker test test/real-postgres-write.spec.ts
```

---

## 5. Running the Deterministic Fault Injection Benchmark

The fault injection benchmark generates 10,000 synthetic records with seed 1337, injects 45 controlled discrepancies across 4 categories, and verifies that the deterministic `ValidationEngine` identifies every single defect with 0 false positives:

```bash
# Using Node native runner in packages/core:
pnpm test:fault-injection

# Using the standalone scenario CLI script (outputs CSV and HTML reports to output/):
node --experimental-strip-types scripts/run-fault-injection.ts
```

Expected Output:
```text
=== MigrationGuard Fault Injection Validation Scenario ===
1. Generating clean synthetic source dataset (10,000 records)...
   Customers: 10000, Orders: 19938, Attachments: 3546
2. Injecting EXACTLY 45 controlled faults into destination dataset:
   - 15 Missing Attachments
   - 10 Duplicate Records
   - 8 Broken References
   - 12 Metadata Mismatches
3. Running Deterministic Validation Engine...
4. Validation Run Completed in 71ms
   Total Discrepancies Detected: 45
5. Verifying Exact Match with Seeded Faults:
   Matched Defects: 45 / 45
   False Positives: 0
 SUCCESS: All 45 seeded discrepancies detected with 0 false positives!
CSV Report written to output/fault-injection-report.csv
HTML Report written to output/fault-injection-report.html
```

---

## 6. Running the Frontend Production Build

Verify Next.js route compilation, typing, and static page generation:

```bash
pnpm --filter @migrationguard/frontend run build:next
```

All 12 routes will compile cleanly:
- `/` (Overview Dashboard)
- `/connections` (Connection Manager)
- `/schema` (Schema Discovery & Snapshot Diff)
- `/mappings` (Mapping Studio)
- `/wizard` (Migration Setup Wizard)
- `/migrations` & `/migrations/[id]` (Batch Monitor & Real-Time Progress)
- `/validation` & `/validation/[id]` (Validation Center & Discrepancy Evidence)
- `/reports` (Assurance Reports)
- `/audit` (Security Audit Timeline)

---

## 7. Development Servers

To run all services simultaneously for interactive development:

```bash
# Terminal 1: Control Plane Backend API (Port 4000)
pnpm dev:backend

# Terminal 2: Migration Data Plane Worker
pnpm dev:worker

# Terminal 3: Next.js Frontend Console (Port 3000)
pnpm dev:frontend
```

Then navigate to `http://localhost:3000` in your browser.
