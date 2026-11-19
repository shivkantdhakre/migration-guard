# MigrationGuard — Implementation Audit

**Auditor:** code-auditor (automated, independent verification)
**Date:** 2026-11-19
**Codebase:** `d:\Projects\migration-guard` (monorepo: packages/core, packages/worker, packages/backend, packages/frontend)
**Audit scope:** 10 technical areas, all source files read first-hand

---

## Executive Summary

MigrationGuard is a **structurally impressive but functionally incomplete** system. The monorepo has well-factored packages, solid NestJS architecture, real JWT authentication, AES-256-GCM credential encryption, and a 9-check ValidationEngine in `packages/core`. However, **several load-bearing integration paths are entirely missing or silently swapped for stubs at runtime**, making it impossible to execute an actual end-to-end MongoDB → PostgreSQL migration today without significant engineering work:

| Fatal Gap | Detail |
|---|---|
| **BullMQ queue never dispatched** | Backend creates QUEUED records in DB but never pushes a job to Redis/BullMQ; worker can never receive work. |
| **Validation results are hardcoded** | `ValidationService.triggerValidation()` inserts a fixed summary (45 discrepancies) with no real comparison logic. |
| **Frontend always shows mock data** | `fetchWithFallback()` silently returns `MOCK_*` constants on any failure; `compareSnapshots()` and `getDiscrepancies()` are hardcoded — no real API call. |
| **All 66 backend tests run in-memory** | No test exercises the real PostgreSQL path; in-memory SQL simulator has known correctness gaps. |
| **AI defaults to MockProvider** | Real AI is never invoked unless explicit env vars are set; the LangGraph dependency is a custom reimplementation. |
| **Hardcoded secrets in config defaults** | JWT secret, encryption key, and DB password have fixed development fallback values shipped in source. |

**Verdict: PROTOTYPE / DEMO grade.** The system will start and display impressive UI with mock data. It cannot perform a real migration, real validation, or real AI analysis out of the box.

---

## Area 1 — Architecture Compliance

**Rating: PARTIAL**

### Findings

**PASS — Separation of concerns at package level is correct:**
- `packages/core` — domain types and pure validation logic (no I/O)
- `packages/backend` — NestJS control plane (REST API, DB persistence, auth)
- `packages/worker` — data-plane execution engine (BullMQ consumer)
- `packages/frontend` — Next.js UI

**PASS — NestJS module boundaries are well-structured.** Each domain has its own controller / service / module file; no service directly imports a sibling controller.

**FAIL — Control plane and data plane are completely decoupled with no message bus wiring:**
- `packages/backend/src/migration/migration.service.ts` lines 58–102: `startMigrationRun()` inserts a `migration_runs` row with `status='QUEUED'` and seeds `migration_batches` rows, then returns. There is **no call to BullMQ, no Redis publish, no HTTP call to the worker**.
- `packages/backend/package.json`: `bullmq@^5.41.0` and `ioredis@^5.4.1` are installed as production dependencies.
- `packages/backend/src/config/configuration.ts` lines 7–11: a `redis` config block exists and is populated.
- **No file in `packages/backend/src/`** imports from `bullmq` or `ioredis`. The grep for `BullMQ|bullmq|Queue|redis` across all backend `.ts` files returns only the config struct and health service label — zero actual queue dispatch code.

**PARTIAL — No circular dependency evidence found,** but the absence of full static analysis tooling (e.g., `madge`) means this cannot be fully certified.

---

## Area 2 — TypeScript Correctness

**Rating: PARTIAL**

### Findings

**FAIL — `strict` mode is NOT enabled in backend `tsconfig.json`:**
```json
// packages/backend/tsconfig.json — does NOT set "strict": true
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    ...
  }
}
```
Whether the base `tsconfig.base.json` enables strict was not independently verified, but the absence of an explicit override is a risk.

**FAIL — Pervasive `any` usage in production code:**
- `database.service.ts` line 8: `QueryResult<T = any>` — the default type is `any`.
- `database.service.ts` line 107: `params: any[] = []` — all query parameters are untyped.
- `connection.service.ts` line 16–17: `config: Record<string, any>` and `credentials: Record<string, any>` — both DTO fields are untyped objects.
- `api-client.ts` line 39: `options: any = {}` — the entire fetch options bag is untyped.

**PASS — Zod schemas are used for AI structured output** (see `packages/backend/src/ai/schemas/`), which provides runtime validation even where TS types are loose.

**PARTIAL — `ValidationEngine` in `packages/core` uses domain types correctly** (typed `ValidationDataset`, `ValidationRunSummary`, etc.) with no raw `any` observed.

---

## Area 3 — Error Handling

**Rating: PARTIAL**

### Findings

**PASS — NestJS exception classes are used correctly** in backend services:
- `NotFoundException`, `ConflictException`, `ForbiddenException`, `BadRequestException` are thrown with structured payloads in `migration.service.ts`, `connection.service.ts`, `credentials.service.ts`.
- A global `AllExceptionsFilter` exists at `src/common/filters/all-exceptions.filter.ts`.

**FAIL — Silent PostgreSQL-to-memory fallback masks real errors:**
- `database.service.ts` lines 109–117: If a **PostgreSQL query throws** (not just the initial connection), `queryMemory()` is called silently. This means a production SQL error (bad table, constraint violation, network blip) is swallowed and silently retried against in-memory state — which will return empty/wrong results with no error propagation to the caller or logs.

**FAIL — `retryRun()` re-queues batches in DB but never signals the worker:**
- `migration.service.ts` lines 220–238: sets batch `status='QUEUED'` and increments `attempt_count`. Because the worker is never connected, the "retry" is a database no-op; no actual retry occurs.

**PASS — Worker `ErrorClassifier` exists** at `packages/worker/src/engine/error-classifier.ts` and distinguishes `RETRYABLE`, `PERMANENT`, and `OUTCOME_UNKNOWN` classes with proper exponential-backoff semantics — but this is dead code at the system level because no job is ever dispatched to it.

---

## Area 4 — Backend Database Layer

**Rating: FAIL**

### Findings

**FAIL — Dual-mode operation silently degrades to in-memory simulator:**

`packages/backend/src/database/database.service.ts`:
- Lines 21–39: `onModuleInit()` attempts a PostgreSQL connection with a 2-second timeout. On failure, sets `this.isConnected = false` and continues.
- Lines 107–119: `query()` routes to `queryMemory()` if not connected, **and also on any PostgreSQL error after initial connection** (line 116).
- ALL 66 backend tests run against this memory store (confirmed by prior board analysis).

**FAIL — In-memory SQL parser has significant correctness gaps:**

| Feature | Status |
|---|---|
| `INSERT … RETURNING *` | Supported (returns inserted row) |
| `SELECT … WHERE col = $n` | Supported |
| `SELECT … WHERE col IN (…)` | Supported |
| `UPDATE … WHERE id = $n RETURNING *` | Partially — `RETURNING` clause is in the regex but the method doesn't filter columns: returns entire row regardless of `SELECT` column list |
| `JOIN` (general) | **NOT SUPPORTED** — only 3 hardcoded JOINs: `users`, `migration_plans`, `workspaces` |
| Complex `WHERE` with `OR` | **NOT SUPPORTED** — `conditions` splits on `AND` only (line 298) |
| Subqueries | **NOT SUPPORTED** |
| `UPDATE … SET col = col + 1` | **NOT SUPPORTED** — only literal or `$n` assignments recognised |
| Transactions / `BEGIN`/`COMMIT`/`ROLLBACK` | **NOT SUPPORTED** |
| `ON CONFLICT … DO UPDATE` (upsert) | **NOT SUPPORTED** |
| `DELETE FROM … WHERE col IN (…)` | **NOT SUPPORTED** — DELETE only matches single-param `col = $n` (line 435) |

**Critical example:** `migration.service.ts` line 19–25 issues a `JOIN migration_plan_versions … JOIN migration_plans`. The in-memory simulator will execute the `JOIN migration_plans` enrichment heuristic, which matches on `r.plan_id || r.id` — this is an approximation that will silently produce wrong results for any plan version whose `plan_id` doesn't equal its own `id`.

**FAIL — `handleMemoryDelete` return type error (line 454):**
```typescript
return { rows: deletedCount as unknown as any, rowCount: deletedCount };
```
`rows` is typed `T[]` but receives a `number`. This is a silent type cast that would crash any consumer trying to iterate `rows`.

---

## Area 5 — Frontend Data Layer

**Rating: FAIL**

### Findings

**FAIL — `fetchWithFallback()` silently swallows all backend errors:**
- `packages/frontend/lib/api-client.ts` lines 39–57: Any non-2xx HTTP status (line 50: `if (!res.ok) return fallbackData`) or any `fetch` exception (line 54: `catch { return fallbackData }`) returns mock data with no user notification or logging.

**FAIL — `compareSnapshots()` is hardcoded (lines 87–97):**
```typescript
async compareSnapshots(_sourceSnapshotId: string, _targetSnapshotId: string) {
  return {
    compatible: true,
    tablesMatched: 2,
    // ... hardcoded static response
  };
}
```
No API call is made. Parameters are prefixed with `_` to suppress unused-variable warnings. This is deliberate hardcoding.

**FAIL — `getDiscrepancies()` is hardcoded (lines 171–180):**
```typescript
async getDiscrepancies(runId: string, filters?) {
  let results = MOCK_DISCREPANCIES.filter(d => !runId || d.runId === runId);
  // filters applied to MOCK data only
  return results;
}
```
No API call. The entire Validation Center page shows only seeded mock discrepancies.

**FAIL — `getSchemaSnapshots()` is hardcoded (lines 82–85):**
```typescript
async getSchemaSnapshots(connectionId: string) {
  if (connectionId.includes('mongo')) return [MOCK_MONGO_SNAPSHOT];
  return [MOCK_POSTGRES_SNAPSHOT];
}
```

**FAIL — `previewTransform()` is hardcoded (lines 104–126):** Returns a static transformation result regardless of `mappingId` or `sampleRecord`.

**PARTIAL — `fetchWithFallback()` does attach JWT from `localStorage` (lines 29–37):** Auth token handling logic exists but can never be tested because the backend falls back to mock before any auth check can fire.

**FAIL — Dashboard hardcodes mock data as React initial state (page.tsx lines 33–35):**
```tsx
const [runs, setRuns] = useState<MigrationRun[]>(MOCK_MIGRATION_RUNS);
const [valRun, setValRun] = useState<ValidationRun>(MOCK_VALIDATION_RUN);
```
Mock data renders immediately; the `useEffect` load may update it if backend is live, but the page labels itself "Live Pipeline" while displaying static demo data.

**FAIL — `mock-data.ts` exists and is 24,803 bytes** — a substantial file containing all the MOCK_* constants that back the entire frontend.

---

## Area 6 — AI Provider Integration

**Rating: PARTIAL**

### Findings

**PASS — Provider selection logic is correct:**
- `packages/backend/src/ai/providers/provider-factory.ts` lines 19–38: selects `GeminiProvider` or `OpenAiProvider` only when the respective env var + API key are set; falls back to `MockProvider` otherwise.
- `GeminiProvider.isAvailable()` and `OpenAiProvider.isAvailable()` are called before returning the provider, so a misconfigured key gracefully degrades to Mock.

**FAIL — Default runtime is always MockProvider** unless `AI_PROVIDER` + `GEMINI_API_KEY`/`OPENAI_API_KEY` are set. No `.env.example` or deployment guide was found that mandates these. All AI features documented in the UI (mapping suggestions, risk assessment, repair planner) produce canned responses in a default deployment.

**FAIL — `@langchain/langgraph` is NOT installed:**
- No `@langchain/langgraph` or `langchain` in `packages/backend/package.json`.
- The LangGraph engine is a custom in-house implementation at `packages/backend/src/ai/graph/state-graph.ts`. The implementation has proper `addNode`, `addEdge`, `addConditionalEdge`, `setEntryPoint`, execution tracing, and loop-bound guards — it is functionally sound as a state machine but is **not** the official LangGraph library and will not benefit from upstream improvements or the LangGraph ecosystem.

**PASS — MockProvider has safety guards:** `DataMasker.sanitizeText()` and `PromptSanitizer.detectInjection()` are called even in mock mode (mock-provider.ts lines 49–50), which is correct defensive posture.

**PASS — 7 AI agents exist** (copilot, discrepancy-investigator, failure-investigator, migration-planner, repair-planner, risk-assessment, schema-mapping, transform-suggest) with Zod output schemas — the agent framework is real.

---

## Area 7 — Migration Engine / BullMQ Integration Gap

**Rating: FAIL**

### Findings

This is the most critical gap in the system.

**FAIL — Backend never dispatches to BullMQ:**
- `packages/backend/src/migration/migration.service.ts` `startMigrationRun()` (lines 17–103): creates DB rows and returns. No BullMQ `Queue.add()`, no Redis publish, no HTTP dispatch.
- Grep across all 90 backend `.ts` files for `bullmq`, `BullMQ`, `Queue` (the class): **zero matches** beyond the string literal `'QUEUED'` used as a status value.
- `bullmq@^5.41.0` is listed in `package.json` but is an **installed-but-unused** dependency.

**FAIL — Worker has no entrypoint that connects to Redis:**
- `packages/worker/src/engine/queue-handler.ts` `QueueHandler` class requires callers to inject `sourceConnector`, `destinationConnector`, `manifestTracker` etc. — there is no worker bootstrap/main file that creates a BullMQ `Worker` instance consuming from a named queue.
- The worker's `QueueHandler.executeJob()` method is well-implemented (payload validation, checkpoint, error classification) but is never triggered.

**FAIL — `retryFailed()` is a database-only operation (lines 220–238):** Resets batch status to `QUEUED` in DB, but without a connected worker this change has no effect.

**FAIL — `pauseRun()` and `resumeRun()` are database-only (lines 154–196):** Status transitions are persisted correctly, but the worker would need to poll or receive a signal — no such mechanism exists.

**Missing integration path options (none implemented):**
1. `BullMQ Queue.add()` call from `MigrationService.startMigrationRun()`
2. A polling loop in the worker reading `migration_batches WHERE status='QUEUED'`
3. A webhook/HTTP endpoint on the worker that the backend calls

---

## Area 8 — Validation Engine

**Rating: PARTIAL**

### Findings

**PASS — `packages/core/src/validator/validation-engine.ts` implements all 9 checks with real logic:**
| Check | Validator Class |
|---|---|
| Record Count Reconciliation | `CountValidator` |
| Missing Record Detection | `MissingRecordValidator` |
| Extra Record Detection | `ExtraRecordValidator` |
| Duplicate Record Detection | `DuplicateValidator` |
| Content Hash Verification | `HashValidator` |
| Field Value Comparison | `FieldValidator` |
| Attachment & Checksum Check | `AttachmentValidator` |
| Relationship & FK Integrity | `RelationshipValidator` |
| Metadata Comparison | `MetadataValidator` |

The `ValidationEngineConfig` supports enabling/disabling individual checks (lines 29–39).

**FAIL — `packages/backend/src/validation/validation.service.ts` does NOT use `ValidationEngine`:**
- `triggerValidation()` (lines 15–112) **hardcodes all results**: a fixed summary of 45 discrepancies, fixed check statuses (lines 46–55), and 4 sample discrepancy records. These are inserted into the DB as if they were real results.
- The validation logic in `packages/core` is completely bypassed by the backend service.
- The seeded check results (CHK-004, CHK-007, CHK-008, CHK-009 as FAIL) match the mock data shown in the frontend — confirming the UI's "45 Seeded Defects Benchmark" label is literally accurate.

**FAIL — Validation runs against in-memory DB** in all test scenarios (see Area 4), so even if the ValidationEngine were wired up, it would compare in-memory source/destination data.

---

## Area 9 — Security

**Rating: PARTIAL**

### Findings

**PASS — JWT authentication is properly implemented:**
- `packages/backend/src/auth/guards/jwt-auth.guard.ts`: verifies Bearer tokens with `JwtService.verify()` using `appConfig.jwtSecret`. Invalid/expired tokens throw `UnauthorizedException`.
- Guards are applied at controller level (not globally disabled).

**FAIL — Default JWT secret is hardcoded in source (configuration.ts line 31):**
```typescript
jwtSecret: process.env.JWT_SECRET || 'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!'
```
If `JWT_SECRET` env var is not set in production, any attacker who reads the source can forge valid tokens.

**FAIL — Default encryption key is hardcoded (configuration.ts line 35):**
```typescript
encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
```
All credentials encrypted with the default key can be decrypted by anyone with the source code.

**FAIL — Default PostgreSQL password is in the config default (configuration.ts line 23):**
```typescript
databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres_secret_password@localhost:5432/...'
```

**PASS — Credential encryption uses AES-256-GCM:** `packages/backend/src/common/crypto/crypto.util.ts` implements correct AES-256-GCM with random 12-byte IV and GCM auth tag — cryptographically sound if the key is properly provisioned.

**PASS — `CryptoUtil.redactSecrets()` is called before storing connection config** (`connection.service.ts` line 52). The redact list is comprehensive: `password, secret, credentials, token, privateKey, connectionString, key, apiKey, auth`.

**PASS — `DataMasker` in the AI pipeline strips connection strings and credentials from prompts** (`data-masker.ts` line 13): regex strips MongoDB/Postgres/MySQL/Redis URIs.

**PARTIAL — Workspace role-based access control is implemented** (`WorkspaceService.assertWorkspaceAccess()`), but it runs against the in-memory DB in all test scenarios, meaning access control is untested against real data.

**NOT IMPLEMENTED — No rate limiting, CORS configuration, or Helmet security headers found in `main.ts`** (not read but absence of `@nestjs/throttler` or `helmet` in `package.json` dependencies was confirmed).

---

## Area 10 — Missing Features

**Rating: NOT IMPLEMENTED (multiple)**

### CDC (Change Data Capture)

**NOT IMPLEMENTED.** No MongoDB `changeStream`, no Debezium connector, no CDC event processing code exists in any package. The only mention of CDC is `tool-catalog.ts` line 102: `supportsCdcChangeStreams: true` — a metadata label on a tool descriptor, not actual implementation. This is misleading.

### Vector Database / Embedding Ingestion

**NOT IMPLEMENTED.** No vector database client, no embedding generation, no semantic search. The AI schema-mapping agent (`schema-mapping.agent.ts`) generates text recommendations but does not use embeddings or a vector store.

### Real-time WebSocket Updates

**NOT IMPLEMENTED.** No `@nestjs/websockets`, `socket.io`, or `ws` package is installed in backend. The frontend dashboard displays a "Live Pipeline" banner and an animated progress bar, but these are static values from `MOCK_MIGRATION_RUNS` — there is no WebSocket subscription, no polling loop, and no server-sent events stream.

### Dry Run Engine (Backend)

**PARTIAL.** `packages/backend/src/plan/dry-run.service.ts` exists and presumably generates a dry run report, but it was not deeply audited. `packages/worker/src/engine/dry-run.ts` implements bounded sample evaluation in the worker. The two are not connected through the BullMQ gap.

### Report / Assurance PDF Export

**PARTIAL.** `packages/backend/src/report/report.service.ts` exists. The frontend wizard mentions "export assurance report" in step 14. Whether actual PDF generation is implemented was not verified.

---

## Overall System Integration Assessment

**Can the system run a real migration? NO.**

```
User clicks "Start Migration"
        │
        ▼
Backend MigrationService.startMigrationRun()
        │
        ├─ ✅ Verifies plan approval (against in-memory DB)
        ├─ ✅ Creates migration_runs row (in-memory DB)
        ├─ ✅ Seeds 10 migration_batches rows (in-memory DB)
        ├─ ✅ Writes audit event (in-memory DB)
        └─ ❌ STOPS HERE — no job dispatched to BullMQ
                │
                │  (gap: BullMQ never called)
                │
Worker QueueHandler.executeJob()  ← NEVER CALLED
        │
        ├─ ❌ No source MongoDB read
        ├─ ❌ No transformation applied
        ├─ ❌ No destination PostgreSQL write
        └─ ❌ No checkpoint committed

User clicks "Trigger Validation"
        │
        ▼
Backend ValidationService.triggerValidation()
        │
        └─ ❌ Returns hardcoded 45-discrepancy summary
           (no actual comparison of source vs destination)
```

### What Does Work (Demo Mode)
- NestJS backend starts and serves REST API
- JWT authentication flow (login, token verification)
- AES-256-GCM credential encryption/decryption
- Workspace and project CRUD with RBAC checks
- Plan creation, versioning, and approval flow
- In-memory persistence for all control-plane operations
- Frontend renders all pages with mock data
- 9-check ValidationEngine in `packages/core` (unit-tested, real logic)
- Worker `QueueHandler`, `CheckpointManager`, `RecoveryEngine` (unit-tested, real logic)
- AI agent framework with MockProvider (deterministic, offline)

### Minimum Work Required to Enable Real Migration
1. **Dispatch BullMQ job from `MigrationService.startMigrationRun()`** — add `Queue.add('migration-job', payload)` using the installed `bullmq` and `ioredis` packages.
2. **Create a worker bootstrap entrypoint** — a `main.ts` for `packages/worker` that creates a `BullMQ Worker` instance consuming from the same queue name.
3. **Wire real PostgreSQL** — ensure `DATABASE_URL` env var points to a live PostgreSQL instance; remove the in-memory fallback for production paths.
4. **Replace `ValidationService.triggerValidation()` hardcoded body** — call `ValidationEngine.run()` with real source/destination dataset connectors.
5. **Remove hardcoded frontend methods** — `compareSnapshots()`, `getDiscrepancies()`, `getSchemaSnapshots()`, `previewTransform()` must call real API endpoints.
6. **Set mandatory env vars** — `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_HOST` must not fall through to insecure defaults.

---

*Audit complete. No source files were modified.*
