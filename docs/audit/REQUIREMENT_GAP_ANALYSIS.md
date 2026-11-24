# MigrationGuard — Requirement Gap Analysis

**Auditor:** req-auditor (Requirements Gap Auditor)  
**Date:** 2026-11-20  
**Baseline Specification:** [02_FRD.md](file:///d:/Projects/migration-guard/02_FRD.md) (59 Functional Requirements)  
**Comparison Target:** [docs/implementation-tracker.md](file:///d:/Projects/migration-guard/docs/implementation-tracker.md) (Claims 100% Completion)  
**Codebase:** `d:\Projects\migration-guard` (monorepo: `packages/core`, `packages/backend`, `packages/worker`, `packages/frontend`)

---

## 1. Executive Summary & Category Breakdown

The previous implementation team declared MigrationGuard **100% Implemented & Verified** across all 59 functional requirements in [implementation-tracker.md](file:///d:/Projects/migration-guard/docs/implementation-tracker.md). 

A rigorous, file-by-file audit of the source code and test suites reveals that **only 10 of the 59 requirements (16.9%) are demonstrably complete and verified against real behavior**. The remaining 49 requirements (83.1%) suffer from severed integration paths, in-memory simulations, hardcoded mock fallbacks, or missing implementations.

### Requirement Status Summary Table

| Status Category | Count | Percentage | Definition |
|---|:---:|:---:|---|
| **VERIFIED COMPLETE** | 10 | 16.9% | The feature exists, is tested against real behavior, and acceptance criteria are demonstrably met. |
| **PARTIALLY IMPLEMENTED** | 46 | 78.0% | Core logic exists but has significant gaps (e.g., in-memory only, no integration, hardcoded fallbacks). |
| **BLOCKED BY ENVIRONMENT** | 1 | 1.7% | Implementation exists in code but cannot be verified without running infrastructure (live DBs, Redis, LLM API keys). |
| **IMPLEMENTED - UNTESTED** | 0 | 0.0% | Code exists with zero test coverage (untested logic in this repo is primarily stubbed or mocked, categorized under Partial). |
| **NOT IMPLEMENTED** | 1 | 1.7% | No corresponding implementation found in any package. |
| **DOCUMENTED ONLY** | 1 | 1.7% | Referenced in tracker as complete, but only type definitions or design docs exist. |
| **TOTAL** | **59** | **100.0%** | All functional requirements from [02_FRD.md](file:///d:/Projects/migration-guard/02_FRD.md). |

```
Requirement Verification Breakdown (59 Total):
████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  16.9% Verified Complete (10)
█████████████████████████████████████░░░  78.0% Partially Implemented (46)
█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1.7% Blocked by Environment (1)
█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1.7% Not Implemented (1)
█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   1.7% Documented Only (1)
```

---

## 2. Gap Between Tracker Claims and Reality

The table below contrasts the previous development team's claims in [implementation-tracker.md](file:///d:/Projects/migration-guard/docs/implementation-tracker.md) with actual source code verification:

| Requirement Group | Total FRs | Tracker Claimed | Verified Complete | Partially Implemented | Blocked / Not Implemented / Doc Only | Reality Check |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **3.1 Identity & Workspace (FR-IAM)** | 3 | 3 (100%) | 0 | 3 | 0 | Guards exist; backend tests run on in-memory DB; frontend swallows 401s. |
| **3.2 Connection Management (FR-CON)** | 5 | 5 (100%) | 0 | 4 | 1 | Credential encryption works; test connection returns synthetic random latency. |
| **3.3 Schema Discovery & Profiling (FR-SCH)** | 5 | 5 (100%) | 0 | 5 | 0 | Core discovery classes exist; backend services return hardcoded mock schemas. |
| **3.4 Mapping & Transformation (FR-MAP)** | 7 | 7 (100%) | 2 | 5 | 0 | Pure transform engine & DSL validator verified; previews mocked in frontend. |
| **3.5 Planning & Approval (FR-PLAN)** | 6 | 6 (100%) | 1 | 5 | 0 | Canonical hashing & approval guard verified; dry runs and AI planning mocked. |
| **3.6 Migration Execution (FR-EXEC)** | 10 | 10 (100%) | 0 | 8 | 2 | **FATAL GAP**: BullMQ is never dispatched; S3 adapter missing; CDC documented only. |
| **3.7 Validation & Assurance (FR-VAL)** | 10 | 10 (100%) | 2 | 8 | 0 | Core hash & report verified; backend hardcodes 45-discrepancy stub. |
| **3.8 AI Copilot & Workflows (FR-AI)** | 7 | 7 (100%) | 4 | 3 | 0 | Tool guards, Zod schemas, data masking verified; real LLM requires manual API key. |
| **3.9 Recovery, Reporting & Audit (FR-REC)**| 6 | 6 (100%) | 1 | 5 | 0 | Error classifier verified; checkpointing/recovery untested with live queue. |
| **TOTAL** | **59** | **59 (100%)** | **10 (16.9%)** | **46 (78.0%)** | **3 (5.1%)** | **83.1% False Completion Rate** |

---

## 3. Top 10 Critical Gaps (Ordered by Business Impact)

### 1. P0 — BullMQ Message Queue Disconnected (Data Plane Inoperable)
- **Requirement:** `FR-EXEC-001`, `FR-EXEC-002`, `FR-EXEC-005`
- **Location:** [migration.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts#L58-L103), [worker-main.ts](file:///d:/Projects/migration-guard/packages/worker/src/worker-main.ts#L36-L56)
- **Reality:** When a user starts a migration run, `MigrationService.startMigrationRun()` creates records in the database with status `QUEUED` and returns. It **never pushes a job to BullMQ or Redis**. On the data plane, `worker-main.ts` listens to `migration-execution` but merely logs and returns a static mock payload (`status: 'PROCESSED'`), never invoking `QueueHandler.processJob()`.
- **Business Impact:** **The platform cannot execute a data migration.**

### 2. P0 — Backend Database Layer Dual-Mode Silent Fallback
- **Requirement:** `FR-IAM-001`, `FR-IAM-002`, `FR-CON-001`, `FR-EXEC-003`
- **Location:** [database.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/database/database.service.ts#L21-L40), [database.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/database/database.service.ts#L107-L121)
- **Reality:** If PostgreSQL is unreachable or throws any query exception at runtime, `DatabaseService` silently falls back to an in-memory Map simulator (`queryMemory()`). All 66 backend tests run against this simulator. The simulator lacks support for transactions, subqueries, general JOINs, and `ON CONFLICT` clauses.
- **Business Impact:** Schema correctness, relational integrity, and concurrent isolation against real PostgreSQL are completely unverified.

### 3. P0 — ValidationService Completely Bypasses ValidationEngine with Hardcoded Stubs
- **Requirement:** `FR-VAL-001`, `FR-VAL-002`, `FR-VAL-004`, `FR-VAL-007`
- **Location:** [validation.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/validation/validation.service.ts#L23-L112)
- **Reality:** When `triggerValidation()` is invoked, it does **not** call `packages/core/src/validator/validation-engine.ts`. Instead, it writes a hardcoded JSON summary (45 discrepancies across 9 fixed checks) and seeds 4 canned rows into the `discrepancies` table.
- **Business Impact:** The system cannot validate actual migrated data. The "45 Seeded Defects Benchmark" is hardcoded into the backend rather than evaluated from source vs destination data.

### 4. P1 — Frontend API Client Silently Swallows Errors with Hardcoded Mock Fallbacks
- **Requirement:** `FR-SCH-005`, `FR-MAP-004`, `FR-VAL-007`
- **Location:** [api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L39-L57), [api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L87-L97), [api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L171-L180)
- **Reality:** `fetchWithFallback()` catches all network failures and non-2xx responses (including 401 Unauthorized), silently returning static `MOCK_*` constants without informing the user. Furthermore, `compareSnapshots()`, `getDiscrepancies()`, and `previewTransform()` don't make network calls at all—they return static dummy objects directly.
- **Business Impact:** The UI displays a convincing "live" facade that masks broken backend endpoints and displays stale mock data during outages.

### 5. P1 — Schema Discovery and Profiling Services Return Canned Fixtures
- **Requirement:** `FR-SCH-001`, `FR-SCH-002`, `FR-SCH-003`
- **Location:** [schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L33-L95), [schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L170-L202)
- **Reality:** `triggerDiscovery()` in the backend returns a hardcoded mock schema for MongoDB (`customers`, `orders`) and PostgreSQL without connecting to either database. `startProfiling()` returns a hardcoded JSON object (`nullPercentages: {'customers.email': 2.4}`) without invoking the core `SchemaProfiler`.
- **Business Impact:** Users cannot discover or profile arbitrary production schemas.

### 6. P1 — Missing Attachment Adapter for S3 / MinIO
- **Requirement:** `FR-EXEC-009`, `FR-VAL-005`
- **Location:** [attachment-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/attachment-validator.ts#L1-L70), [mock-provider.js](file:///d:/Projects/migration-guard/packages/backend/dist/ai/providers/mock-provider.js#L173)
- **Reality:** While `AttachmentValidator` exists in `packages/core` to validate arrays of record metadata in memory, **no binary attachment adapter exists**. There is no AWS S3 SDK, no MinIO client, and no file streaming pipeline. Mentions of S3 are confined to strings in mock AI responses.
- **Business Impact:** Attachments cannot be extracted, transferred, or checksum-verified in production object storage.

### 7. P1 — Default AI Pipeline Operates Strictly on Deterministic Mocks
- **Requirement:** `FR-AI-001`, `FR-AI-006`, `FR-PLAN-005`
- **Location:** [provider-factory.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/providers/provider-factory.ts#L19-L38), [mock-provider.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/providers/mock-provider.ts#L49-L55)
- **Reality:** All AI agents default to `MockProvider`, which emits canned static text. No LLM integration tests exist. Furthermore, `@langchain/langgraph` is not installed; an in-house custom state machine ([state-graph.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/graph/state-graph.ts)) is used instead.
- **Business Impact:** AI capabilities (natural-language planning, discrepancy clustering, copilot advice) are non-functional without explicit external API key configuration.

### 8. P1 — Insecure Development Fallback Secrets in Source Code
- **Requirement:** `FR-IAM-001`, `FR-CON-001`
- **Location:** [configuration.ts](file:///d:/Projects/migration-guard/packages/backend/src/config/configuration.ts#L23-L37)
- **Reality:** `configuration.ts` ships with hardcoded default values for `JWT_SECRET` (`'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!'`), `ENCRYPTION_KEY` (`'0123456789abcdef0123456789abcdef...'`), and `DATABASE_URL`.
- **Business Impact:** If deployed without mandatory environment overrides, attackers can forge admin JWTs and decrypt stored database connection credentials.

### 9. P2 — Change Data Capture (CDC) is Documented Only
- **Requirement:** `FR-EXEC-010`
- **Location:** [contract.ts](file:///d:/Projects/migration-guard/packages/core/src/connectors/contract.ts#L1-L25), [types/index.ts](file:///d:/Projects/migration-guard/packages/core/src/types/index.ts)
- **Reality:** The implementation tracker marks `FR-EXEC-010` as "Completed" citing `contract.ts` and `types/index.ts`. However, these files contain only TypeScript type signatures and interface declarations. There are no MongoDB change stream listeners, PostgreSQL logical replication slots, or Debezium integrations.
- **Business Impact:** Real-time incremental synchronization is entirely unimplemented.

### 10. P0 — Absence of End-to-End (E2E) Integration Testing
- **Requirement:** All Execution & Validation FRs
- **Location:** `packages/backend/test/`, `packages/core/test/`, `packages/worker/test/`
- **Reality:** Not a single test exercises the full pipeline: `API Request → BullMQ → Worker Execution → MongoDB Extract → Transform → PostgreSQL Write → Core Validation → Report Output`. Every package is tested in complete isolation against in-memory mocks.
- **Business Impact:** Regressions and systemic integration failures cannot be caught prior to manual production testing.

---

## 4. Full Functional Requirements Audit

Below is the exhaustive audit of all 59 functional requirements specified in [02_FRD.md](file:///d:/Projects/migration-guard/02_FRD.md).

### 4.1 Identity and Workspace (FR-IAM)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-IAM-001` (P0) | Authenticate users before exposing workspace data (401 on unauth) | **PARTIALLY IMPLEMENTED** | `JwtAuthGuard` ([jwt-auth.guard.ts](file:///d:/Projects/migration-guard/packages/backend/src/auth/guards/jwt-auth.guard.ts)) verifies Bearer tokens and throws 401. However, tests run against in-memory DB, default JWT secret is hardcoded in source, and frontend `fetchWithFallback()` ([api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L50)) swallows 401s and returns mock data. |
| `FR-IAM-002` (P0) | Scope projects, connections, runs, reports to authorized workspace | **PARTIALLY IMPLEMENTED** | `WorkspaceService.assertWorkspaceAccess()` ([workspace.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/workspace/workspace.service.ts)) validates workspace membership in SQL queries. Verified only against in-memory map simulator; multi-tenant isolation unverified against real PostgreSQL. |
| `FR-IAM-003` (P1) | Support read-only auditor access (Viewer vs Engineer/Admin) | **PARTIALLY IMPLEMENTED** | `RolesGuard` ([roles.guard.ts](file:///d:/Projects/migration-guard/packages/backend/src/auth/guards/roles.guard.ts)) enforces role hierarchies (`Viewer < Engineer < Admin < Owner`). Verified in backend unit tests; frontend UI does not dynamically disable write actions based on user roles. |

### 4.2 Connection Management (FR-CON)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-CON-001` (P0) | Create named connection profiles without exposing secret material | **PARTIALLY IMPLEMENTED** | `ConnectionService.createConnection()` ([connection.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/connection/connection.service.ts#L52)) calls `CryptoUtil.redactSecrets()`. However, AES-256-GCM encryption falls back to hardcoded dev key, and records are stored in memory in test environments. |
| `FR-CON-002` (P0) | Test connectivity and permissions; return sanitized outcome, never creds | **PARTIALLY IMPLEMENTED** | `ConnectionService.testConnection()` ([connection.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/connection/connection.service.ts#L119-L150)) checks credential decryptability from vault and returns hardcoded capabilities with synthetic random latency (`Math.random() * 20 + 10`). It **never connects to MongoDB or PostgreSQL**. |
| `FR-CON-003` (P0) | Support MongoDB source and PostgreSQL destination connectors | **BLOCKED BY ENVIRONMENT** | Connector implementations exist in `packages/core` ([mongo-connector.ts](file:///d:/Projects/migration-guard/packages/core/src/connectors/mongodb/mongo-connector.ts), [postgres-connector.ts](file:///d:/Projects/migration-guard/packages/core/src/connectors/postgres/postgres-connector.ts)) using official driver packages, but cannot be verified without live database instances. Backend tests do not use them. |
| `FR-CON-004` (P0) | Credential rotation with version incrementing; active runs retain versions | **PARTIALLY IMPLEMENTED** | `CredentialsService.rotateCredentials()` ([credentials.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/connection/credentials.service.ts)) increments version numbers in `connection_secrets`. However, active runs cannot retain versions in practice because execution is non-functional. |
| `FR-CON-005` (P1) | Reuse multiple connection profiles across projects | **PARTIALLY IMPLEMENTED** | Connection profiles are workspace-scoped and referenced across multiple plans. Tested only against in-memory store. |

### 4.3 Schema Discovery and Profiling (FR-SCH)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-SCH-001` (P0) | Discover MongoDB databases, collections, field paths, observed BSON types | **PARTIALLY IMPLEMENTED** | Core class `SchemaDiscovery` ([schema-discovery.ts](file:///d:/Projects/migration-guard/packages/core/src/discovery/schema-discovery.ts)) exists, but backend `SchemaService.triggerDiscovery()` ([schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L33-L64)) returns a hardcoded mock schema (`customers`, `orders`) without executing MongoDB driver calls. |
| `FR-SCH-002` (P0) | Discover PostgreSQL schemas, tables, columns, types, nullability, PK/FK | **PARTIALLY IMPLEMENTED** | Core connector contains `information_schema` query definitions, but backend `SchemaService.triggerDiscovery()` ([schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L65-L95)) returns a hardcoded PostgreSQL mock schema. |
| `FR-SCH-003` (P0) | Profile a bounded configurable sample (null %, type variation, counts) | **PARTIALLY IMPLEMENTED** | Core `SchemaProfiler` ([profiler.ts](file:///d:/Projects/migration-guard/packages/core/src/profiling/profiler.ts)) contains sample profiling algorithms. However, backend `SchemaService.startProfiling()` ([schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L170-L202)) bypasses it and inserts hardcoded sample stats. |
| `FR-SCH-004` (P0) | Flag incompatible types, required target fields without source values | **PARTIALLY IMPLEMENTED** | DSL validator flags type mismatches in static mappings ([dsl-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/mapping/dsl-validator.ts)), but live profiling integration is not connected to mapping creation. |
| `FR-SCH-005` (P1) | Compare immutable schema snapshots (added, removed, modified) | **PARTIALLY IMPLEMENTED** | Backend `SchemaService.compareSnapshots()` ([schema.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/schema/schema.service.ts#L214-L245)) performs set differences on snapshot JSON. However, frontend `apiClient.compareSnapshots()` ([api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L87-L97)) is hardcoded and never calls backend. |

### 4.4 Mapping and Transformation (FR-MAP)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-MAP-001` (P0) | Map source paths to destination columns/JSON fields; versioned config | **PARTIALLY IMPLEMENTED** | `MappingService` ([mapping.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/mapping/mapping.service.ts)) persists versioned mapping documents in `mapping_versions`. Tested against in-memory database simulator only. |
| `FR-MAP-002` (P0) | Provide deterministic transformations (RENAME, TRIM, PARSE_*, TO_JSONB, etc.) | **VERIFIED COMPLETE** | `packages/core/src/transforms/operations.ts` implements all 13 deterministic transform operators. Fully tested and verified with extensive assertions in `packages/core/test/transforms.spec.ts`. |
| `FR-MAP-003` (P0) | Validate mapping DSL before preview/execution; block invalid operations | **VERIFIED COMPLETE** | `DslValidator` ([dsl-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/mapping/dsl-validator.ts)) strictly validates operation allowlists, field paths, and required columns. Fully verified in `packages/core/test/mapping-dsl.spec.ts`. |
| `FR-MAP-004` (P0) | Preview transformed sample records without writing to destination | **PARTIALLY IMPLEMENTED** | Preview logic exists in core ([preview.ts](file:///d:/Projects/migration-guard/packages/core/src/transforms/preview.ts)) and backend `MappingPreviewService`. However, frontend `apiClient.previewTransform()` ([api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L104-L126)) bypasses the API and returns hardcoded Acme Enterprise mock data. |
| `FR-MAP-005` (P0) | Preserve source-to-destination ID correspondence (ID mappings table) | **PARTIALLY IMPLEMENTED** | `IdTracker` ([id-tracker.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/id-tracker.ts)) manages ID translation pairs. Verified in unit tests ([id-tracker.spec.ts](file:///d:/Projects/migration-guard/packages/worker/test/id-tracker.spec.ts)), but not invoked in end-to-end migrations due to queue disconnection. |
| `FR-MAP-006` (P1) | AI proposes field mappings with rationale, assumptions and confidence | **PARTIALLY IMPLEMENTED** | `SchemaMappingAgent` ([schema-mapping.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/schema-mapping.agent.ts)) outputs structured suggestions adhering to Zod schemas. Defaults to `MockProvider` unless external LLM keys are configured. |
| `FR-MAP-007` (P1) | AI proposes transformations for ambiguous structures | **PARTIALLY IMPLEMENTED** | `TransformSuggestAgent` ([transform-suggest.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/transform-suggest.agent.ts)) proposes allowlisted operations. Defaults to `MockProvider`. |

### 4.5 Planning and Approval (FR-PLAN)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-PLAN-001` (P0) | Create migration plan linking connections, snapshots, mapping version | **PARTIALLY IMPLEMENTED** | `PlanService.createPlan()` ([plan.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/plan/plan.service.ts)) validates references and persists plan versions. Tested against in-memory database simulator. |
| `FR-PLAN-002` (P0) | Plan specifies objects, scope, batch size, concurrency, write mode | **PARTIALLY IMPLEMENTED** | DTOs in [plan.dto.ts](file:///d:/Projects/migration-guard/packages/backend/src/plan/plan.dto.ts) enforce all execution settings. Verified in backend unit tests in memory. |
| `FR-PLAN-003` (P0) | Provide dry run against bounded sample or isolated target | **PARTIALLY IMPLEMENTED** | Worker has `DryRunEngine` ([dry-run.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/dry-run.ts)) and backend has `DryRunService`. However, backend dry run operates on synthetic fixtures and is not integrated with live connectors. |
| `FR-PLAN-004` (P0) | Require explicit approval of exact canonical plan hash before execution | **VERIFIED COMPLETE** | Canonical hashing is implemented in `packages/core/src/canonical/index.ts`. `MigrationService.startMigrationRun()` ([migration.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts#L39-L56)) enforces an explicit check on `approvals` table matching canonical hash, throwing `ForbiddenException('PLAN_NOT_APPROVED')` on mismatch. Verified in `plan-approval-hashing.spec.ts`. |
| `FR-PLAN-005` (P1) | AI drafts structured migration plan from natural language | **PARTIALLY IMPLEMENTED** | `MigrationPlannerAgent` ([migration-planner.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/migration-planner.agent.ts)) generates structured plans matching `PlannerOutputSchema`. Defaults to `MockProvider`. |
| `FR-PLAN-006` (P1) | Generate migration readiness report (facts vs hypotheses) | **PARTIALLY IMPLEMENTED** | `ReadinessService` ([readiness.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/plan/readiness.service.ts)) compiles readiness summaries. Risk agent produces fact vs hypothesis splits, but runs on `MockProvider`. |

### 4.6 Migration Execution (FR-EXEC)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-EXEC-001` (P0) | Start approved plans asynchronously and return run ID | **PARTIALLY IMPLEMENTED** | `MigrationController.startRun()` returns a run ID and sets state to `QUEUED`. However, **execution halts after database row creation**; no message is ever sent to BullMQ or worker daemon. |
| `FR-EXEC-002` (P0) | Read/write bounded batches; queue messages carry IDs, not records | **PARTIALLY IMPLEMENTED** | `QueueHandler.validatePayload()` ([queue-handler.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/queue-handler.ts#L82-L133)) strictly rejects messages containing bulk records (`records`, `rows`, etc.). However, backend never publishes messages to the queue. |
| `FR-EXEC-003` (P0) | Persist batch manifest, state, cursor, read/written/failed counts | **PARTIALLY IMPLEMENTED** | `BatchManifestTracker` ([batch-manifest.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/batch-manifest.ts)) tracks sub-stages and manifests. Tested in `manifest.spec.ts`, but not wired to live backend. |
| `FR-EXEC-004` (P0) | Retry only bounded transient failures; permanent errors halt | **PARTIALLY IMPLEMENTED** | Worker has `ErrorClassifier` ([error-classifier.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/error-classifier.ts)). However, backend `retryFailed()` ([migration.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/migration/migration.service.ts#L220-L238)) only updates database rows and never communicates with the worker. |
| `FR-EXEC-005` (P0) | Support pause/resume; explicit in-flight behavior | **PARTIALLY IMPLEMENTED** | `MigrationRunner` ([migration-runner.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/migration-runner.ts)) supports pause states. Backend endpoints exist, but only modify DB status flags without signaling active workers. |
| `FR-EXEC-006` (P0) | Make supported destination writes idempotent | **PARTIALLY IMPLEMENTED** | `DestinationWriter` ([destination-writer.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/destination-writer.ts)) formats `ON CONFLICT` clauses. Verified against mock connector in `idempotency.spec.ts`. In-memory database simulator does not support `ON CONFLICT`. |
| `FR-EXEC-007` (P0) | Expose records processed, succeeded, failed, skipped, throughput | **PARTIALLY IMPLEMENTED** | `ProgressService` calculates metrics from database batch rows. However, no live WebSocket/SSE streaming exists; frontend dashboard renders static mock numbers. |
| `FR-EXEC-008` (P0) | Store sanitized run/batch logs with correlation IDs; redact secrets | **PARTIALLY IMPLEMENTED** | `AppLogger` ([app-logger.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/common/logger/app-logger.service.ts)) and `AuditService` log correlation IDs and redact credentials. Tested against in-memory store. |
| `FR-EXEC-009` (P1) | Support attachment adapter with size and checksum validation | **NOT IMPLEMENTED** | Tracker claims completion in `attachment-validator.ts`. But `attachment-validator.ts` is only a validator for in-memory record objects. **No binary attachment adapter (S3/MinIO) exists.** |
| `FR-EXEC-010` (P2) | Support CDC through database-native or established technology | **DOCUMENTED ONLY** | Tracker claims completion in `contract.ts` and `types/index.ts`. No CDC listener, MongoDB changeStream consumer, PostgreSQL logical replication client, or incremental synchronization engine exists. Only TypeScript interface definitions exist. |

### 4.7 Validation and Assurance (FR-VAL)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-VAL-001` (P0) | Compare expected/actual record counts with scope/exclusions | **PARTIALLY IMPLEMENTED** | `CountValidator` ([count-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/count-validator.ts)) exists in `packages/core`. However, backend `ValidationService.triggerValidation()` ([validation.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/validation/validation.service.ts#L45-L66)) bypasses it and inserts hardcoded check results. |
| `FR-VAL-002` (P0) | Reconcile key-sets: missing, extra, duplicate records | **PARTIALLY IMPLEMENTED** | Core validator classes (`MissingRecordValidator`, `ExtraRecordValidator`, `DuplicateValidator`) work on in-memory datasets. Backend bypasses them with hardcoded database inserts; frontend hardcodes discrepancy list. |
| `FR-VAL-003` (P0) | Content hash comparison over canonicalized fields | **VERIFIED COMPLETE** | `HashValidator` ([hash-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/hash-validator.ts)) canonicalizes field values using `Canonicalizer.canonicalize()` and computes SHA-256 hashes. Verified in `packages/core/test/canonical.spec.ts` and `fault-injection.spec.ts`. |
| `FR-VAL-004` (P0) | Parent-child relationship and foreign key integrity | **PARTIALLY IMPLEMENTED** | `RelationshipValidator` ([relationship-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/relationship-validator.ts)) verifies foreign key references in memory. Bypassed by backend service with hardcoded CHK-008. |
| `FR-VAL-005` (P0) | Attachment presence and checksum verification | **PARTIALLY IMPLEMENTED** | `AttachmentValidator` ([attachment-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/attachment-validator.ts)) verifies checksums of in-memory object arrays. Verified in fault injection tests. Bypassed by backend service with hardcoded CHK-007. |
| `FR-VAL-006` (P0) | Configured metadata comparison | **PARTIALLY IMPLEMENTED** | `MetadataValidator` ([metadata-validator.ts](file:///d:/Projects/migration-guard/packages/core/src/validator/metadata-validator.ts)) compares metadata fields. Verified in in-memory tests. Bypassed by backend service with hardcoded CHK-009. |
| `FR-VAL-007` (P0) | Discrepancy persistence (category, severity, identifiers, evidence) | **PARTIALLY IMPLEMENTED** | `ValidationService` writes to `discrepancies` table, but seeds 4 static sample rows rather than persisting results from the ValidationEngine. Frontend `getDiscrepancies()` filters mock data directly. |
| `FR-VAL-008` (P0) | Export CSV and HTML reports | **VERIFIED COMPLETE** | `packages/core/src/reports/csv-report.ts` and `html-report.ts` generate comprehensive assurance reports with metadata, scope, check breakdowns, and discrepancy tables. Verified in `fault-injection.spec.ts` and artifacts in `output/`. |
| `FR-VAL-009` (P1) | AI groups discrepancies & suggests root causes (linked to IDs) | **PARTIALLY IMPLEMENTED** | `DiscrepancyInvestigatorAgent` ([discrepancy-investigator.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/discrepancy-investigator.agent.ts)) groups discrepancies. Defaults to `MockProvider` returning canned clusters. |
| `FR-VAL-010` (P1) | Human-reviewed remediation proposal generation (allowlisted proposals, operator approval required) | **PARTIALLY IMPLEMENTED (SCOPE CLARIFIED)** | `RepairPlannerAgent` ([repair-planner.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/repair-planner.agent.ts)) generates structured repair actions constrained to allowlisted operations. Scope is strictly human-reviewed remediation proposal generation; automated repair execution and autonomous rollback pipelines are out-of-scope / deferred. |

### 4.8 AI Copilot and Agent Workflows (FR-AI)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-AI-001` (P1) | Natural language Copilot citing internal evidence | **PARTIALLY IMPLEMENTED** | `CopilotAgent` ([copilot.agent.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/agents/copilot.agent.ts)) structures responses with `evidenceRefs`. Runs on `MockProvider`. Frontend `apiClient.sendCopilotMessage()` ([api-client.ts](file:///d:/Projects/migration-guard/packages/frontend/lib/api-client.ts#L183-L199)) falls back to a canned string. |
| `FR-AI-002` (P1) | Planner restricted to read-only tools; cannot execute runs | **VERIFIED COMPLETE** | `ToolGuard` ([tool-guard.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/tools/tool-guard.ts)) strictly enforces read-only tool allowlisting and forbids mutation tools (`executeMigration`, `approvePlan`) for the planner agent. Verified in `packages/backend/test/ai/tool-guard.spec.ts`. |
| `FR-AI-003` (P1) | Validate all AI outputs against strict versioned schemas | **VERIFIED COMPLETE** | `packages/backend/src/ai/schemas/` uses Zod schemas (`PlannerOutputSchema`, `MappingSuggestionSchema`, `RepairPlannerOutputSchema`, etc.) to parse and validate all agent outputs. Verified in `packages/backend/test/ai/schema-validation.spec.ts`. |
| `FR-AI-004` (P1) | Allowlisted workspace-scoped AI tools with permission checks | **PARTIALLY IMPLEMENTED** | `ToolCatalog` ([tool-catalog.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/tools/tool-catalog.ts)) defines allowlisted tools with permission checks. Tested in memory. |
| `FR-AI-005` (P1) | Data minimization: metadata, aggregates, masked samples only | **VERIFIED COMPLETE** | `DataMasker` ([data-masker.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/masking/data-masker.ts)) strips connection URIs, passwords, credentials, and sensitive tokens from AI prompts. Verified in `packages/backend/test/ai/data-masking.spec.ts`. |
| `FR-AI-006` (P1) | Persist AI traces (model, prompt version, tool calls, latency) | **PARTIALLY IMPLEMENTED** | `TraceService` ([trace.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/trace.service.ts)) records trace rows to `ai_traces` table. Verified in `ai-trace.spec.ts` against in-memory DB. |
| `FR-AI-007` (P1) | Core app fully functional with AI disabled | **VERIFIED COMPLETE** | `MockProvider` ([mock-provider.ts](file:///d:/Projects/migration-guard/packages/backend/src/ai/providers/mock-provider.ts)) enables full offline execution without external API keys. System starts and core validation/mapping functions operate with `AI_ENABLED=false`. Verified in `offline-mock.spec.ts`. |

### 4.9 Recovery, Reporting and Audit (FR-REC)

| FR ID | Requirement Summary | Status | Evidence & Actual Code Behavior |
|---|---|---|---|
| `FR-REC-001` (P0) | Resume from last committed checkpoint without duplicates/skipped | **PARTIALLY IMPLEMENTED** | `CheckpointManager` ([checkpoint.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/checkpoint.ts)) and `RecoveryEngine` ([recovery-engine.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/recovery-engine.ts)) implement checkpoint recovery logic. Verified in `checkpoint-resume.spec.ts`. However, worker is not connected to backend or real queues. |
| `FR-REC-002` (P0) | Distinguish retryable, permanent, unknown failures using connector rules | **VERIFIED COMPLETE** | `ErrorClassifier` ([error-classifier.ts](file:///d:/Projects/migration-guard/packages/worker/src/engine/error-classifier.ts)) implements rule-based connector error classification into `RETRYABLE`, `PERMANENT`, and `OUTCOME_UNKNOWN` based on error codes and message patterns. Verified in `packages/worker/test/error-classifier.spec.ts`. |
| `FR-REC-003` (P0) | Provide timeline for creation, approval, start, batches, validation | **PARTIALLY IMPLEMENTED** | `TimelineService` ([timeline.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/audit/timeline.service.ts)) constructs audit timelines from `audit_events`. Tested in `audit.spec.ts` against in-memory store. |
| `FR-REC-004` (P0) | Append-only audit events for approvals and privileged operations | **PARTIALLY IMPLEMENTED** | `AuditService` ([audit.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/audit/audit.service.ts)) inserts audit events. In production, real DB append-only immutability (triggers/permissions) is not enforced; tested in memory only. |
| `FR-REC-005` (P0) | Export run report containing plan hash, counts, validation status | **PARTIALLY IMPLEMENTED** | `ReportService` ([report.service.ts](file:///d:/Projects/migration-guard/packages/backend/src/report/report.service.ts)) compiles run reports. However, backend validation counts are hardcoded stubs. |
| `FR-REC-006` (P1) | Generate scoped recovery/rollback plan listing prerequisites | **PARTIALLY IMPLEMENTED** | `RecoveryEngine` and `RepairPlannerAgent` generate recovery plans. Tested against mock fixtures in isolation. |

---

## 5. Audit Conclusions & Recommendations

1. **Do not trust tracker claims of 100% completion:** The implementation tracker was written as an aspirational marketing document rather than an engineering audit. 49 of 59 requirements require active engineering remediation before they can be considered production-ready.
2. **Prioritize P0 Integration over New Features:** The individual components (`packages/core` validation engine, `packages/worker` queue handler, `packages/backend` NestJS API) are well-architected. The catastrophic failure is in the **integration wiring** (BullMQ dispatch, live PostgreSQL persistence, live ValidationEngine execution).
3. **Establish Real End-to-End Test Harness:** Replace in-memory mock tests with a Docker Compose test harness running live PostgreSQL, MongoDB, and Redis instances.
