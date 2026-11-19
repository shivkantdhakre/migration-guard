# MigrationGuard Implementation Tracker & Requirements Traceability Matrix

**Project:** MigrationGuard — AI-Native Data Migration & Assurance Platform  
**Baseline Date:** 19 November 2026  
**Status:** 58 of 59 Functional Requirements Implemented (100% of P0 & P1); 1 Deferred to Phase 2 (FR-EXEC-010 P2 CDC Continuous Ingestion)

---

## 1. Traceability Matrix

### 1.1 Identity & Access Management (FR-IAM)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-IAM-001` | Authenticate users before exposing workspace data (401 on unauth) | P0 | `packages/backend/src/auth/*` | `packages/backend/test/auth.spec.ts` | Completed |
| `FR-IAM-002` | Scope projects, connections, runs, reports to authorized workspace | P0 | `packages/backend/src/workspace/*` | `packages/backend/test/workspace-isolation.spec.ts` | Completed |
| `FR-IAM-003` | Support read-only auditor role (Viewer vs Admin/Owner) | P1 | `packages/backend/src/auth/guards/roles.guard.ts` | `packages/backend/test/workspace-isolation.spec.ts` | Completed |

### 1.2 Connection Management (FR-CON)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-CON-001` | Create named connection profiles without exposing secret material in responses | P0 | `packages/backend/src/connection/*` | `packages/backend/test/connection-redaction.spec.ts` | Completed |
| `FR-CON-002` | Test connectivity & capabilities; return sanitized outcome, never creds | P0 | `packages/backend/src/connection/connection.service.ts` | `packages/backend/test/connection-redaction.spec.ts` | Completed |
| `FR-CON-003` | Support MongoDB source and PostgreSQL destination connectors | P0 | `packages/core/src/connectors/mongodb/mongo-connector.ts`, `packages/core/src/connectors/postgres/postgres-connector.ts` | `packages/core/test/mongo-connector.spec.ts`, `packages/core/test/postgres-connector.spec.ts` | Completed |
| `FR-CON-004` | Credential rotation with version incrementing; active runs retain versions | P0 | `packages/backend/src/connection/credentials.service.ts` | `packages/backend/test/connection-redaction.spec.ts` | Completed |
| `FR-CON-005` | Reuse connection profiles across projects | P1 | `packages/backend/src/connection/*` | `packages/backend/test/connection-redaction.spec.ts` | Completed |

### 1.3 Schema Discovery & Profiling (FR-SCH)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-SCH-001` | Discover MongoDB databases, collections, field paths, observed BSON types | P0 | `packages/core/src/discovery/schema-discovery.ts` | `packages/core/test/schema-discovery.spec.ts` | Completed |
| `FR-SCH-002` | Discover PostgreSQL tables, columns, types, nullability, PK/FK | P0 | `packages/core/src/connectors/postgres/postgres-connector.ts` | `packages/core/test/postgres-connector.spec.ts` | Completed |
| `FR-SCH-003` | Bounded configurable sample profiling (null %, type variation, counts) | P0 | `packages/core/src/profiling/profiler.ts` | `packages/core/test/profiling.spec.ts` | Completed |
| `FR-SCH-004` | Flag incompatible types, required target fields without source values | P0 | `packages/core/src/mapping/dsl-validator.ts`, `packages/core/src/profiling/profiler.ts` | `packages/core/test/mapping-dsl.spec.ts`, `packages/core/test/profiling.spec.ts` | Completed |
| `FR-SCH-005` | Compare immutable schema snapshots (added, removed, modified) | P1 | `packages/core/src/discovery/schema-discovery.ts` | `packages/core/test/schema-discovery.spec.ts` | Completed |

### 1.4 Mapping & Transformation (FR-MAP)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-MAP-001` | Map source paths to destination columns/JSON fields; versioned config | P0 | `packages/core/src/transforms/engine.ts`, `packages/backend/src/mapping/*` | `packages/core/test/transforms.spec.ts`, `packages/backend/test/mapping-dsl-preview.spec.ts` | Completed |
| `FR-MAP-002` | Deterministic transformations (RENAME, TRIM, PARSE_*, TO_JSONB, etc.) | P0 | `packages/core/src/transforms/operations.ts` | `packages/core/test/transforms.spec.ts` | Completed |
| `FR-MAP-003` | Validate mapping DSL before preview/execution; block invalid operations | P0 | `packages/core/src/mapping/dsl-validator.ts` | `packages/core/test/mapping-dsl.spec.ts` | Completed |
| `FR-MAP-004` | Preview transformed sample records without writing to destination | P0 | `packages/core/src/transforms/preview.ts`, `packages/backend/src/mapping/mapping-preview.service.ts` | `packages/core/test/preview.spec.ts`, `packages/backend/test/mapping-dsl-preview.spec.ts` | Completed |
| `FR-MAP-005` | Preserve source-to-destination ID correspondence (ID mappings table) | P0 | `packages/worker/src/engine/id-tracker.ts` | `packages/worker/test/id-tracker.spec.ts` | Completed |
| `FR-MAP-006` | AI proposes field mappings with confidence and rationale (advisory) | P1 | `packages/backend/src/ai/agents/mapping-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |
| `FR-MAP-007` | AI proposes transformations for ambiguous structures | P1 | `packages/backend/src/ai/agents/mapping-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |

### 1.5 Planning & Approval (FR-PLAN)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-PLAN-001` | Migration plan linking connections, snapshots, mapping version | P0 | `packages/backend/src/plan/*` | `packages/backend/test/plan-approval-hashing.spec.ts` | Completed |
| `FR-PLAN-002` | Plan specifies objects, scope, batch size, concurrency, write mode | P0 | `packages/backend/src/plan/plan.dto.ts` | `packages/backend/test/plan-approval-hashing.spec.ts` | Completed |
| `FR-PLAN-003` | Dry run against bounded sample or isolated target | P0 | `packages/worker/src/engine/dry-run.ts`, `packages/backend/src/plan/plan.service.ts` | `packages/worker/test/dry-run.spec.ts`, `packages/backend/test/plan-approval-hashing.spec.ts` | Completed |
| `FR-PLAN-004` | Require explicit approval of exact canonical plan hash before execution | P0 | `packages/backend/src/plan/plan.service.ts`, `packages/core/src/canonical/index.ts` | `packages/backend/test/plan-approval-hashing.spec.ts`, `packages/core/test/canonical.spec.ts` | Completed |
| `FR-PLAN-005` | AI drafts structured migration plan from natural language | P1 | `packages/backend/src/ai/agents/planner-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |
| `FR-PLAN-006` | Generate migration readiness report (facts vs hypotheses) | P1 | `packages/backend/src/plan/plan.service.ts` | `packages/backend/test/plan-approval-hashing.spec.ts` | Completed |

### 1.6 Migration Execution (FR-EXEC)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-EXEC-001` | Start approved plans asynchronously, returning run ID | P0 | `packages/backend/src/migration/migration.controller.ts` | `packages/backend/test/plan-approval-hashing.spec.ts` | Completed |
| `FR-EXEC-002` | Read/write bounded batches; queue messages carry IDs, not records | P0 | `packages/worker/src/engine/batch-reader.ts`, `packages/worker/src/engine/queue-handler.ts` | `packages/worker/test/bounded-memory.spec.ts`, `packages/worker/test/queue-handler.spec.ts` | Completed |
| `FR-EXEC-003` | Persist batch manifest, state, cursor, read/written/failed counts | P0 | `packages/worker/src/engine/batch-manifest.ts` | `packages/worker/test/manifest.spec.ts` | Completed |
| `FR-EXEC-004` | Retry bounded transient errors; permanent errors halt/require review | P0 | `packages/worker/src/engine/error-classifier.ts` | `packages/worker/test/error-classifier.spec.ts` | Completed |
| `FR-EXEC-005` | Pause / resume migration runs safely | P0 | `packages/worker/src/engine/migration-runner.ts` | `packages/worker/test/pause-resume.spec.ts` | Completed |
| `FR-EXEC-006` | Idempotent destination writes (insert-only, upsert by stable keys) | P0 | `packages/worker/src/engine/destination-writer.ts` | `packages/worker/test/idempotency.spec.ts` | Completed |
| `FR-EXEC-007` | Real-time progress counters, throughput, state transitions | P0 | `packages/backend/src/migration/migration.service.ts`, `packages/worker/src/engine/migration-runner.ts` | `packages/backend/test/plan-approval-hashing.spec.ts`, `packages/worker/test/pause-resume.spec.ts` | Completed |
| `FR-EXEC-008` | Redacted structured logs with correlation IDs | P0 | `packages/backend/src/audit/audit.service.ts`, `packages/backend/src/ai/masking/` | `packages/backend/test/audit.spec.ts`, `packages/backend/test/ai/data-masking.spec.ts` | Completed |
| `FR-EXEC-009` | Attachment adapter (S3/MinIO) with size and checksum validation | P1 | `packages/core/src/validator/attachment-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-EXEC-010` | CDC / incremental synchronization architecture hooks | P2 | `packages/core/src/connectors/contract.ts`, `packages/core/src/types/index.ts` | `packages/core/test/mongo-connector.spec.ts` | Deferred to Phase 2 (Hooks Implemented) |

### 1.7 Validation & Assurance (FR-VAL)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-VAL-001` | Record count reconciliation with scope/exclusions | P0 | `packages/core/src/validator/count-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-VAL-002` | Reconcile key-sets: missing, extra, duplicate records | P0 | `packages/core/src/validator/missing-record-validator.ts`, `extra-record-validator.ts`, `duplicate-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-VAL-003` | Content hash comparison over canonicalized fields | P0 | `packages/core/src/validator/hash-validator.ts` | `packages/core/test/fault-injection.spec.ts`, `packages/core/test/canonical.spec.ts` | Completed |
| `FR-VAL-004` | Parent-child relationship and foreign key integrity | P0 | `packages/core/src/validator/relationship-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-VAL-005` | Attachment presence and checksum verification | P0 | `packages/core/src/validator/attachment-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-VAL-006` | Configured metadata comparison | P0 | `packages/core/src/validator/metadata-validator.ts` | `packages/core/test/fault-injection.spec.ts` | Completed |
| `FR-VAL-007` | Discrepancy persistence (category, severity, identifiers, evidence) | P0 | `packages/backend/src/validation/validation.service.ts` | `packages/backend/test/validation-report.spec.ts` | Completed |
| `FR-VAL-008` | Export CSV and HTML reports | P0 | `packages/core/src/reports/csv-report.ts`, `packages/core/src/reports/html-report.ts`, `packages/backend/src/report/report.service.ts` | `packages/core/test/fault-injection.spec.ts`, `packages/backend/test/validation-report.spec.ts` | Completed |
| `FR-VAL-009` | AI groups discrepancies & suggests root causes (linked to IDs) | P1 | `packages/backend/src/ai/agents/discrepancy-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |
| `FR-VAL-010` | AI proposes remediation steps (allowlisted, requires approval) | P1 | `packages/backend/src/ai/agents/repair-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |

### 1.8 AI Copilot & Agent Workflows (FR-AI)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-AI-001` | Natural language Copilot citing internal evidence | P1 | `packages/backend/src/ai/agents/copilot-agent.ts` | `packages/backend/test/ai/ai-agents.spec.ts` | Completed |
| `FR-AI-002` | Planner restricted to read-only tools; cannot execute runs | P1 | `packages/backend/src/ai/safety/tool-guard.ts` | `packages/backend/test/ai/tool-guard.spec.ts` | Completed |
| `FR-AI-003` | Validate all AI outputs against strict versioned schemas | P1 | `packages/backend/src/ai/safety/schema-validator.ts` | `packages/backend/test/ai/schema-validation.spec.ts` | Completed |
| `FR-AI-004` | Allowlisted workspace-scoped AI tools with permission checks | P1 | `packages/backend/src/ai/tools/registry.ts`, `packages/backend/src/ai/safety/tool-guard.ts` | `packages/backend/test/ai/tool-guard.spec.ts` | Completed |
| `FR-AI-005` | Data minimization: metadata, aggregates, masked samples only | P1 | `packages/backend/src/ai/masking/data-masker.ts` | `packages/backend/test/ai/data-masking.spec.ts` | Completed |
| `FR-AI-006` | Persist AI traces (model, prompt version, tool calls, latency) | P1 | `packages/backend/src/ai/trace.service.ts` | `packages/backend/test/ai/ai-trace.spec.ts` | Completed |
| `FR-AI-007` | Core app fully functional with AI disabled | P1 | `packages/backend/src/ai/providers/mock-provider.ts` | `packages/backend/test/ai/offline-mock.spec.ts` | Completed |

### 1.9 Recovery, Reporting & Audit (FR-REC)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-REC-001` | Resume from last committed checkpoint without duplicates/skipped | P0 | `packages/worker/src/engine/checkpoint.ts`, `recovery-engine.ts` | `packages/worker/test/checkpoint-resume.spec.ts`, `packages/worker/test/recovery-engine.spec.ts` | Completed |
| `FR-REC-002` | Error classification into retryable, permanent, unknown | P0 | `packages/worker/src/engine/error-classifier.ts` | `packages/worker/test/error-classifier.spec.ts` | Completed |
| `FR-REC-003` | Migration run lifecycle and audit timeline | P0 | `packages/backend/src/audit/audit.service.ts` | `packages/backend/test/audit.spec.ts` | Completed |
| `FR-REC-004` | Immutable append-only audit events for privileged actions | P0 | `packages/backend/src/audit/audit.service.ts` | `packages/backend/test/audit.spec.ts` | Completed |
| `FR-REC-005` | Export comprehensive run report with validation evidence | P0 | `packages/core/src/reports/csv-report.ts`, `html-report.ts`, `packages/backend/src/report/*` | `packages/core/test/fault-injection.spec.ts`, `packages/backend/test/validation-report.spec.ts` | Completed |
| `FR-REC-006` | Scoped recovery plan generation | P1 | `packages/backend/src/ai/agents/repair-agent.ts`, `packages/worker/src/engine/recovery-engine.ts` | `packages/backend/test/ai/ai-agents.spec.ts`, `packages/worker/test/recovery-engine.spec.ts` | Completed |

---

## 2. Test Scenarios & Fault Injection Validation

### 2.1 Fault Injection Test Suite (Seeded Discrepancies)
- **Dataset:** 10,000 synthetic records with embedded structures, parent-child references, metadata, attachments.
- **Seeded Defects:**
  - 15 Missing attachments (`ATTACHMENT_MISSING`)
  - 10 Duplicate records (`DUPLICATE_RECORD`)
  - 8 Broken references (`BROKEN_REFERENCE`)
  - 12 Metadata mismatches (`METADATA_MISMATCH`)
  - **Total:** Exactly 45 seeded defect instances.
- **Validation Requirement:**
  - Validator must detect and identify exact IDs of all 45 discrepancies.
  - Zero false positives on clean records.
  - Generates HTML & CSV reports reflecting exact discrepancies.
- **Verification Status:** PASSED (5/5 tests in `packages/core/test/fault-injection.spec.ts`, 45/45 detected, 0 false positives).

---

## 3. Implementation Phases Progress
- [x] **Phase 0:** Repository & Architecture Setup, Docker, Shared Core, Tracker
- [x] **Phase 1:** Core Connectors, Mapping DSL, Migration Engine, Checkpointing & Recovery
- [x] **Phase 2:** Deterministic Validation Engine & Fault Injection Demonstration
- [x] **Phase 3:** AI Agents (Planner, Mapping, Risk, Failure Investigator, Discrepancy Investigator, Copilot)
- [x] **Phase 4:** Enterprise Next.js Frontend Console
- [x] **Phase 5:** End-to-End Testing, Hardening & Verification
