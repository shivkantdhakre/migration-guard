# MigrationGuard Consolidated Audit & Code Review Remediation Report
**Audit Remediation Baseline Commit:** `437d8595e92a65039d7664db019d517f3277bceb`  
**Current Verified Head Commit:** [`1bd71aa6e8e0bd1417935736f08498b7c5c83ca3`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts)  
**GitHub Actions CI Status:** [Run #45286638690 (SUCCESS)](https://github.com/shivkantdhakre/migration-guard/actions/runs/45286638690)  
**Date:** November 24, 2026  
**Author:** Senior Backend & Distributed Systems Engineering Team  

---

## 1. Executive Summary

This report documents the final resolution and comprehensive remediation of **all outstanding P0/P1 audit findings and GitHub code review issues** across the MigrationGuard distributed migration engine.

All fixes were implemented directly in production code paths within [`packages/core`](file:///d:/Projects/migration-guard/packages/core), [`packages/backend`](file:///d:/Projects/migration-guard/packages/backend), and [`packages/worker`](file:///d:/Projects/migration-guard/packages/worker). No mocks, synthetic data fallbacks, or weakened tests were used in production flows.

### Commit History & Remediation Progression

| Commit | Component | Summary |
|---|---|---|
| [`db2bf8c`](file:///d:/Projects/migration-guard/packages/backend/src/validation/validation.service.ts) | Backend & Worker | Fix initial P0/P1 issues for validation, outbox, recovery, schema discovery, dry-run, and AI tools. |
| [`c02de3b`](file:///d:/Projects/migration-guard/packages/backend/test/p0-p1-regression.spec.ts) | Backend Tests | Use unique emails in P0/P1 regression suite to prevent uniqueness collisions across test runs. |
| [`0a43006`](file:///d:/Projects/migration-guard/packages/backend/src/database/database.service.ts) | Database | Cache schema migration across test lifecycle and cleanly close connection pools. |
| [`079bf17`](file:///d:/Projects/migration-guard/packages/worker/src/engine/recovery-engine.ts) | Worker Recovery | Enforce canonical RFC 8785 hashes and propagate `destinationKey` in recovery reconciliation. |
| [`68a33b6`](file:///d:/Projects/migration-guard/packages/backend/src/plan/dry-run.service.ts) | Plan & Validation | Mapping-aware validation, fail-closed live sampling, and multi-object dry-runs. |
| [`570e056`](file:///d:/Projects/migration-guard/packages/backend/src/ai/masking/data-masker.ts) | AI Masking | Prevent UUID identifiers from being mutilated by phone number PII regex in DataMasker. |
| [`09badff`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts) | Worker Streaming | Guard worker automatic streaming dispatch with `ENABLE_WORKER_AUTO_STREAMING` flag. |
| [`902a67e`](file:///d:/Projects/migration-guard/packages/backend/src/database/database.service.ts) | Database | Allow schema migrations to execute across isolated custom search path schemas. |
| [`0094f68`](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts) | Core & Backend | Fix outbox concurrency, dry-run safety, and AI tenant isolation. |
| [`ee82210`](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts) | Full Monorepo | Resolve GitHub code review findings for outbox concurrency, worker streaming, crash recovery, and readiness. |
| [`e8542b4`](file:///d:/Projects/migration-guard/AUDIT_REMEDIATION_REPORT.md) | Documentation | Finalize consolidated audit remediation report. |
| [`157cdfa`](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts) | Monorepo Core | Remediate code-review findings in startup recovery SQL, outbox transaction-scoped locking, validation fail-closed on missing count evidence, secure AI record comparison & safe SQL identifiers, eliminate foreign actor substitution in audit logs, multi-object independent key resolution, live database catalog inspection in dry-run & readiness, and historical schema upgrade delta parity. |
| [`96ffb49`](file:///d:/Projects/migration-guard/packages/backend/test/production-readiness-audit-final.spec.ts) | Monorepo Core | Finalize production-readiness remediation: fail-closed startup recovery, two-way checkpoint-crash-window reconciliation, dry-run live sampling safety, live schema constraint verification, strict zero-record validation evidence, audit attribution isolation, AI SQL injection defense, and streaming metadata durability. |
| [`1bd71aa`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts) | Worker Recovery | Align test-mode synthetic source checks in worker recovery with backend `isStrict` definition. |

---

## 2. Architecture & Distributed Data Flow

```mermaid
flowchart TD
    subgraph Phase1["1. Live Schema Discovery, Dry-Run & Readiness"]
        SrcDB[Live MongoDB Source] -->|Real BSON & Sample Discovery| Discovery[Schema Discovery & Profiler]
        DstDB[Live PostgreSQL Destination] -->|Live pg_catalog & information_schema| Discovery
        Discovery -->|Workspace Scoped| Readiness[Readiness Service]
        Readiness -->|Live Credential Probes & Compatibility Verification| PlanGate[Plan Approval & Dry-Run Gate]
    end

    subgraph Phase2["2. Transactional Outbox & Concurrency"]
        PlanGate --> OutboxPending[migration_batches: status=PENDING]
        OutboxPending -->|pg_try_advisory_xact_lock + FOR UPDATE SKIP LOCKED| BullMQDispatch[BullMQ Redis Enqueue: deterministic jobId]
        BullMQDispatch -->|PostgreSQL Transaction Commit (Distributed Boundary)| OutboxQueued[migration_batches: status=QUEUED]
    end

    subgraph Phase3["3. Worker Execution & Crash Recovery"]
        OutboxQueued --> WorkerPipeline[Worker Pipeline Execution]
        WorkerPipeline --> CanonicalHash[RFC 8785 Canonical Hashing]
        CanonicalHash --> ManifestTracker[record_manifests: status=WRITTEN]
        WorkerPipeline -.->|Crash / Restart / Stranded Run| RecoveryEngine[RecoveryEngine.prepareResume]
        RecoveryEngine -->|Verify Destination Records by destinationKey + RFC 8785 Hash| ManifestTracker
        RecoveryEngine -->|Reject FAILED & Verify SKIPPED Records| CheckpointManager[advanceCheckpoint]
    end

    subgraph Phase4["4. Validation Gate & AI Tenant Isolation"]
        ManifestTracker --> ValidationService[Validation Service]
        SrcDB -->|Independent Enumeration: countDocuments| ValidationService
        DstDB -->|Independent Enumeration: SELECT COUNT| ValidationService
        ValidationService -->|Fail Closed on Missing Evidence| ValidationRun[validation_runs: outcome=PASSED / FAILED]
        AIToolCatalog[AI ToolCatalog] -->|Tenant Isolated by Workspace ID & Safe SQL Identifiers| DstDB
        AIToolCatalog -->|Verified Actor Membership Only| AuditEvents[audit_events table]
    end
```

---

## 3. Comprehensive Breakdown of All Remediated Findings

### 1. Startup Recovery SQL & Fail-Fast Lifecycle
- **Root Cause:** In [`worker-main.ts`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts), `reconcileStrandedRunsOnStartup()` queried `mb.sub_stage IN ('WRITE_STARTED', 'DESTINATION_WRITTEN', 'MANIFEST_COMMITTED')`. The `migration_batches` table has no `sub_stage` column in PostgreSQL (sub-stage was an in-memory batch metadata field). This query threw `column mb.sub_stage does not exist`, which was caught and swallowed by an empty catch block, allowing workers to start up without reconciling stranded runs.
- **Fix Implemented:**
  - Removed `mb.sub_stage` from the candidate runs query in [`packages/worker/src/worker-main.ts`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts#L525-L535), querying only valid schema statuses `mr.status = 'RUNNING' OR mb.status IN ('RUNNING', 'OUTCOME_UNKNOWN', 'RETRY_WAIT')`.
  - Changed the catch block to log a fatal error and re-throw (`throw err`), ensuring the worker process halts immediately if startup reconciliation cannot be completed safely.

### 2. Multi-Object Recovery & Independent Identity Key Resolution
- **Root Cause:** `reconcileStrandedRunsOnStartup()` resolved the destination connector and identity key only once for `objectsRes.rows[0]`, then reused that single identity key for all mapped objects in the run.
- **Fix Implemented:**
  - Moved connector and mapping resolution inside the object iteration loop (`for (const objRow of objectsRes.rows)`).
  - Each mapped object now independently resolves its specific destination connector, mapping definition, and `destinationKey` from `migration_plan_versions` and `mapping_versions`.

### 3. Outbox Locking & Dual-System Distributed Coordination
- **Root Cause:** `dispatchPendingOutboxBatches` previously acquired a session-level advisory lock (`SELECT pg_try_advisory_lock(...)`) outside the transaction, and released it in `finally` with `SELECT pg_advisory_unlock(...)`. In pooled connections or on unhandled disconnections, session-level advisory locks can leak across connection pool reuses. Additionally, earlier descriptions loosely referred to an "atomic transaction commit" across PostgreSQL and Redis, which is physically impossible without distributed transactions (XA), which BullMQ does not support.
- **Fix Implemented:**
  - Removed redundant session-level advisory locking (`pg_try_advisory_lock` / `pg_advisory_unlock`) from [`packages/backend/src/migration/migration.service.ts`](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts#L251-L290).
  - Relies exclusively on transaction-scoped PostgreSQL advisory locking (`SELECT pg_try_advisory_xact_lock(hashtext($1))`) and atomic batch claims (`SELECT * FROM migration_batches WHERE status = 'PENDING' ... FOR UPDATE SKIP LOCKED`) inside `this.db.transaction()`.
  - Transaction-scoped advisory locks are automatically released by PostgreSQL on transaction commit or rollback, eliminating any connection pool leakage.
  - **Explicit Distributed Systems Boundary:** PostgreSQL and Redis form a distributed system boundary. Atomicity across both systems is impossible; instead, at-least-once safety with deterministic idempotency is guaranteed:
    1. Batches remain in `PENDING` outbox state in PostgreSQL until Redis enqueue succeeds. If Redis enqueue fails, the PostgreSQL transaction rolls back immediately and the batch remains `PENDING` for automatic retry.
    2. Deterministic BullMQ job IDs (`migration_${runId}_${batchKey}`) prevent duplicate jobs from executing in Redis if retried.
    3. The PostgreSQL transition from `PENDING` to `QUEUED` occurs after Redis confirms receipt, or is caught up during startup reconciliation.
    4. Worker startup and runtime recovery via `RecoveryEngine` inspects destination records and canonical RFC 8785 hashes, guaranteeing idempotent processing even if a job was dispatched more than once.

### 4. Validation Fail-Closed on Missing Count Evidence & Zero-Record Support
- **Root Cause:** In [`packages/backend/src/validation/validation.service.ts`](file:///d:/Projects/migration-guard/packages/backend/src/validation/validation.service.ts), if live source or destination connection queries were not attempted or credentials were unavailable, `sourceCountQueried` and `destCountQueried` remained false. In production, validation proceeded to evaluate only manifest records without asserting source and destination counts, creating a false-pass risk.
- **Fix Implemented:**
  - Enforced fail-closed behavior in production (`process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false'`): if `!sourceCountQueried || !destCountQueried`, an explicit failure is recorded in `validation_runs` and an error is thrown.
  - When both counts are queried and both equal zero (`sourceCount === 0 && destCount === 0`), the dataset is verified empty. The `COUNT_MISMATCH` check passes with 0 discrepancies and evaluates cleanly without synthetic injection.
  - Guaranteed that `outcome = 'PASSED'` is asserted only when all required evidence exists: `allCheckResults.length > 0 && totalFailedChecks === 0 && allDiscrepancies.length === 0 && objectsValidated.length > 0`.

### 5. Secure AI Record Comparison & Safe SQL Identifiers
- **Root Cause:** In `ToolCatalog.compare_sample_records`, dynamic table and column identifiers (`manifest.destination_object`, `destKeyField`, `manifest.source_object`, `sourceKeyField`) were directly interpolated into SQL queries without identifier validation. Additionally, when live retrieval failed or was unsupported, the tool incorrectly returned `NOT_FOUND` instead of `UNAVAILABLE`.
- **Fix Implemented:**
  - Added strict identifier validation via `assertSafeIdentifier(name, context)` in [`packages/backend/src/ai/tools/tool-catalog.ts`](file:///d:/Projects/migration-guard/packages/backend/src/ai/tools/tool-catalog.ts). Any identifier containing invalid characters, quotes, or punctuation throws an immediate error.
  - Validates `manifest.destination_object`, `destKeyField`, `manifest.source_object`, and `sourceKeyField` before query execution.
  - Tracks live query execution (`srcQueried`, `dstQueried`). If engine or credentials are unsupported, returns `{ status: 'UNAVAILABLE' }`. Returns `{ status: 'NOT_FOUND' }` **only** when live queries successfully executed against the database but the records were absent.

### 6. Audit Attribution & Elimination of Foreign Actor Substitution
- **Root Cause:** In `ToolCatalog.create_draft_proposal` and `request_human_approval`, when an actor was not found in the workspace, the code fell back to `SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = $1 LIMIT 1` (`anyMember`), attributing the audit event to an arbitrary workspace member.
- **Fix Implemented:**
  - Completely removed the `anyMember` fallback query in [`packages/backend/src/ai/tools/tool-catalog.ts`](file:///d:/Projects/migration-guard/packages/backend/src/ai/tools/tool-catalog.ts).
  - Scopes actor verification strictly to `wm.workspace_id = $1 AND u.id = $2`.
  - When `this.db.isDbConnected` is true, the actor must exist as a verified member of the workspace. If the actor cannot be verified, the audit event is safely omitted and never attributed to another member.

### 7. Schema Validation Against Live Database Catalogs
- **Root Cause:** Dry-run and readiness checks relied exclusively on static `schema_snapshots`, which could be stale if the target schema changed after snapshot capture.
- **Fix Implemented:**
  - In [`packages/backend/src/plan/dry-run.service.ts`](file:///d:/Projects/migration-guard/packages/backend/src/plan/dry-run.service.ts) and [`packages/backend/src/plan/readiness.service.ts`](file:///d:/Projects/migration-guard/packages/backend/src/plan/readiness.service.ts):
    - When `destination_connection_id` is configured with valid credentials, directly inspects the live PostgreSQL `information_schema.tables`, `columns`, `table_constraints`, and `key_column_usage`.
    - Validates target tables, column nullability, data types, and primary key/unique constraints against the live destination database catalog.
    - If a target table or identity key is missing in the live destination database, generates an explicit blocker.

### 8. Worker Streaming Durable Outbox Routing
- **Root Cause:** In earlier iterations, `worker-main.ts` directly inserted batches with `status = 'QUEUED'` and enqueued them to Redis.
- **Fix Implemented:**
  - All dynamically generated streaming batches insert into `migration_batches` with `status = 'PENDING'` and complete metadata (`source_object`, `destination_object`, cursors, mapping version, connection IDs, and identity key).
  - Batches transition to `QUEUED` atomically inside a transaction with `FOR UPDATE SKIP LOCKED` upon successful BullMQ enqueue.

### 9. Crash Recovery Verification & Canonical Hashing
- **Root Cause:** Ambiguous batches could advance checkpoints without destination content verification.
- **Fix Implemented:**
  - In [`packages/worker/src/engine/recovery-engine.ts`](file:///d:/Projects/migration-guard/packages/worker/src/engine/recovery-engine.ts):
    - Refuses to commit batches containing `FAILED` manifests or `recordsFailed > 0`.
    - Verifies `SKIPPED` records against destination database via `readByKeys`.
    - Requires valid RFC 8785 canonical content hashes matching stored manifest hashes in production.
    - Advances checkpoints only after complete destination evidence is verified.

### 10. Schema Manifest Upgrade Historical Delta Parity
- **Root Cause:** The `migration_batches` table had an `updated_at` column added to track outbox transitions, but `packages/backend/test/schema-manifest-upgrade.spec.ts` did not have `updated_at` in its `EXPECTED_SCHEMA_DELTA.modifiedTables.migration_batches.addedColumns`.
- **Fix Implemented:**
  - Added `updated_at` column specification (`data_type: 'timestamp with time zone'`, `udt_name: 'timestamptz'`, `is_nullable: 'YES'`) to `EXPECTED_SCHEMA_DELTA` in [`schema-manifest-upgrade.spec.ts`](file:///d:/Projects/migration-guard/packages/backend/test/schema-manifest-upgrade.spec.ts), maintaining full schema manifest upgrade parity.

---

## 4. Test Verification & CI Results

### Local Test Execution Evidence

1. **Core Package Test Suite:**
   ```powershell
   pnpm --filter @migrationguard/core test
   ```
   **Output:** `Test Suites: 14 passed (14)`, `Tests: 96 passed (96)`, `Duration: 2.30s`.  
   Covers RFC 8785 UTF-16 code unit ordering, surrogate validation, all 13 transformation primitives, and evidence redaction.

2. **Worker Package Test Suite:**
   ```powershell
   pnpm --filter @migrationguard/worker test
   ```
   **Output:** `Test Files: 21 passed (21)`, `Tests: 114 passed | 12 skipped (126)`, `Duration: 44.47s`.  
   Includes new dedicated test suite [`packages/worker/test/checkpoint-crash-window.spec.ts`](file:///d:/Projects/migration-guard/packages/worker/test/checkpoint-crash-window.spec.ts), covering two-way crash reconciliation between batch commit and checkpoint advancement, missing manifests, and partial write hash verification.

3. **Backend Package Test Suite:**
   ```powershell
   pnpm --filter @migrationguard/backend test
   ```
   **Output:** `Test Files: 27 passed (27)`, `Tests: 159 passed | 9 skipped (168)`, `Duration: 33.28s`.  
   Includes new dedicated test suite [`packages/backend/test/production-readiness-audit-final.spec.ts`](file:///d:/Projects/migration-guard/packages/backend/test/production-readiness-audit-final.spec.ts), covering dry-run control-plane fallback rejection, live schema blockers, zero-record validation evidence, audit attribution verification, AI record comparison SQL injection defense, and streaming metadata durability.

4. **Monorepo Build & Typecheck:**
   ```powershell
   pnpm build
   ```
   **Output:** Exit code 0 across `@migrationguard/core`, `@migrationguard/frontend`, `@migrationguard/worker`, and `@migrationguard/backend`.

### Remote GitHub Actions CI Architecture & Evidence

The GitHub Actions workflow `.github/workflows/ci.yml` consists of a single primary CI Job named **`Build & Monorepo Test Suite`** (`build-and-test`) running against containerized PostgreSQL 16, Redis 7, and MongoDB 7.0 service containers.

- **Repository:** `shivkantdhakre/migration-guard`
- **Branch:** `main`
- **Head Commit:** [`1bd71aa6e8e0bd1417935736f08498b7c5c83ca3`](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts)
- **Workflow:** `CI` (`.github/workflows/ci.yml`)
- **Run ID:** `45286638690`
- **Run URL:** [https://github.com/shivkantdhakre/migration-guard/actions/runs/45286638690](https://github.com/shivkantdhakre/migration-guard/actions/runs/45286638690)
- **CI Job Name:** `Build & Monorepo Test Suite` (Ubuntu Latest, Node.js 22, pnpm 9)
- **Status:** `completed`
- **Conclusion:** **`success`**

#### Execution Steps within CI Job `Build & Monorepo Test Suite`:

| Step Number | Step Name | Step Description | Status | Conclusion |
|:---:|---|---|:---:|:---:|
| 1 | Set up job | Prepare runner environment and credentials | Completed | **Success** |
| 2 | Initialize containers | Start Redis 7, MongoDB 7.0, and PostgreSQL 16 service containers | Completed | **Success** |
| 3 | Checkout repository | Fetch branch `main` at tested SHA | Completed | **Success** |
| 4 | Setup Node.js | Configure Node.js 22 runtime | Completed | **Success** |
| 5 | Setup pnpm | Install pnpm 9 package manager | Completed | **Success** |
| 6 | Install dependencies | Run frozen-lockfile dependency resolution | Completed | **Success** |
| 7 | Typecheck and Build packages | Execute `pnpm --recursive run build` | Completed | **Success** |
| 8 | Test Core | Execute `@migrationguard/core` unit tests (96 tests) | Completed | **Success** |
| 9 | Test Worker | Execute `@migrationguard/worker` test suites (126 tests, live Redis/Postgres/Mongo) | Completed | **Success** |
| 10 | Test Backend | Execute `@migrationguard/backend` test suites (168 tests) | Completed | **Success** |
| 11 | Complete job | Clean up runner and finalize status | Completed | **Success** |
