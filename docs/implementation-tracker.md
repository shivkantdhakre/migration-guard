# MigrationGuard Implementation Tracker & Requirements Traceability Matrix

**Project:** MigrationGuard — AI-Native Data Migration & Assurance Platform  
**Baseline Date:** 19 November 2026  
**Status:** In Progress — Active Tracking

---

## 1. Traceability Matrix

### 1.1 Identity & Access Management (FR-IAM)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-IAM-001` | Authenticate users before exposing workspace data (401 on unauth) | P0 | `packages/backend/src/auth/*` | `packages/backend/test/auth.spec.ts` | Planned |
| `FR-IAM-002` | Scope projects, connections, runs, reports to authorized workspace | P0 | `packages/backend/src/workspace/*` | `packages/backend/test/workspace-isolation.spec.ts` | Planned |
| `FR-IAM-003` | Support read-only auditor role (Viewer vs Admin/Owner) | P1 | `packages/backend/src/auth/guards/roles.guard.ts` | `packages/backend/test/roles.spec.ts` | Planned |

### 1.2 Connection Management (FR-CON)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-CON-001` | Create named connection profiles without exposing secret material in responses | P0 | `packages/backend/src/connection/*` | `packages/backend/test/connection.spec.ts` | Planned |
| `FR-CON-002` | Test connectivity & capabilities; return sanitized outcome, never creds | P0 | `packages/backend/src/connection/connection.service.ts` | `packages/backend/test/connection-test.spec.ts` | Planned |
| `FR-CON-003` | Support MongoDB source and PostgreSQL destination connectors | P0 | `packages/core/src/connectors/mongo.ts`, `packages/core/src/connectors/postgres.ts` | `packages/core/test/connectors.spec.ts` | Planned |
| `FR-CON-004` | Credential rotation with version incrementing; active runs retain versions | P0 | `packages/backend/src/connection/credentials.service.ts` | `packages/backend/test/credential-rotation.spec.ts` | Planned |
| `FR-CON-005` | Reuse connection profiles across projects | P1 | `packages/backend/src/connection/*` | Integration tests | Planned |

### 1.3 Schema Discovery & Profiling (FR-SCH)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-SCH-001` | Discover MongoDB databases, collections, field paths, observed BSON types | P0 | `packages/core/src/discovery/mongo-discovery.ts` | `packages/core/test/mongo-discovery.spec.ts` | Planned |
| `FR-SCH-002` | Discover PostgreSQL tables, columns, types, nullability, PK/FK | P0 | `packages/core/src/discovery/postgres-discovery.ts` | `packages/core/test/postgres-discovery.spec.ts` | Planned |
| `FR-SCH-003` | Bounded configurable sample profiling (null %, type variation, counts) | P0 | `packages/core/src/profiler/*` | `packages/core/test/profiler.spec.ts` | Planned |
| `FR-SCH-004` | Flag incompatible types, required target fields without source values | P0 | `packages/core/src/profiler/compatibility.ts` | `packages/core/test/compatibility.spec.ts` | Planned |
| `FR-SCH-005` | Compare immutable schema snapshots (added, removed, modified) | P1 | `packages/core/src/discovery/snapshot-diff.ts` | `packages/core/test/snapshot-diff.spec.ts` | Planned |

### 1.4 Mapping & Transformation (FR-MAP)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-MAP-001` | Map source paths to destination columns/JSON fields; versioned config | P0 | `packages/core/src/mapping/*` | `packages/core/test/mapping.spec.ts` | Planned |
| `FR-MAP-002` | Deterministic transformations (RENAME, TRIM, PARSE_*, TO_JSONB, etc.) | P0 | `packages/core/src/transform/transforms.ts` | `packages/core/test/transforms.spec.ts` | Planned |
| `FR-MAP-003` | Validate mapping DSL before preview/execution; block invalid operations | P0 | `packages/core/src/mapping/dsl-validator.ts` | `packages/core/test/dsl-validator.spec.ts` | Planned |
| `FR-MAP-004` | Preview transformed sample records without writing to destination | P0 | `packages/backend/src/mapping/mapping-preview.service.ts` | `packages/backend/test/mapping-preview.spec.ts` | Planned |
| `FR-MAP-005` | Preserve source-to-destination ID correspondence (ID mappings table) | P0 | `packages/worker/src/engine/id-tracker.ts` | `packages/worker/test/id-tracker.spec.ts` | Planned |
| `FR-MAP-006` | AI proposes field mappings with confidence and rationale (advisory) | P1 | `packages/backend/src/ai/agents/schema-mapping.agent.ts` | `packages/backend/test/schema-mapping-agent.spec.ts` | Planned |
| `FR-MAP-007` | AI proposes transformations for ambiguous structures | P1 | `packages/backend/src/ai/agents/transform-suggest.agent.ts` | `packages/backend/test/ai-agents.spec.ts` | Planned |

### 1.5 Planning & Approval (FR-PLAN)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-PLAN-001` | Migration plan linking connections, snapshots, mapping version | P0 | `packages/backend/src/plan/*` | `packages/backend/test/plan.spec.ts` | Planned |
| `FR-PLAN-002` | Plan specifies objects, scope, batch size, concurrency, write mode | P0 | `packages/backend/src/plan/plan.dto.ts` | `packages/backend/test/plan-validation.spec.ts` | Planned |
| `FR-PLAN-003` | Dry run against bounded sample or isolated target | P0 | `packages/worker/src/engine/dry-run.ts` | `packages/worker/test/dry-run.spec.ts` | Planned |
| `FR-PLAN-004` | Require explicit approval of exact canonical plan hash before execution | P0 | `packages/backend/src/approval/*` | `packages/backend/test/approval.spec.ts` | Planned |
| `FR-PLAN-005` | AI drafts structured migration plan from natural language | P1 | `packages/backend/src/ai/agents/migration-planner.agent.ts` | `packages/backend/test/planner-agent.spec.ts` | Planned |
| `FR-PLAN-006` | Generate migration readiness report (facts vs hypotheses) | P1 | `packages/backend/src/plan/readiness.service.ts` | `packages/backend/test/readiness.spec.ts` | Planned |

### 1.6 Migration Execution (FR-EXEC)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-EXEC-001` | Start approved plans asynchronously, returning run ID | P0 | `packages/backend/src/migration/migration.controller.ts` | `packages/backend/test/migration-lifecycle.spec.ts` | Planned |
| `FR-EXEC-002` | Read/write bounded batches; queue messages carry IDs, not records | P0 | `packages/worker/src/engine/batch-reader.ts` | `packages/worker/test/bounded-memory.spec.ts` | Planned |
| `FR-EXEC-003` | Persist batch manifest, state, cursor, read/written/failed counts | P0 | `packages/worker/src/engine/batch-manifest.ts` | `packages/worker/test/manifest.spec.ts` | Planned |
| `FR-EXEC-004` | Retry bounded transient errors; permanent errors halt/require review | P0 | `packages/worker/src/engine/error-classifier.ts` | `packages/worker/test/error-classifier.spec.ts` | Planned |
| `FR-EXEC-005` | Pause / resume migration runs safely | P0 | `packages/worker/src/engine/migration-runner.ts` | `packages/worker/test/pause-resume.spec.ts` | Planned |
| `FR-EXEC-006` | Idempotent destination writes (insert-only, upsert by stable keys) | P0 | `packages/worker/src/engine/destination-writer.ts` | `packages/worker/test/idempotency.spec.ts` | Planned |
| `FR-EXEC-007` | Real-time progress counters, throughput, state transitions | P0 | `packages/backend/src/migration/progress.service.ts` | `packages/backend/test/progress.spec.ts` | Planned |
| `FR-EXEC-008` | Redacted structured logs with correlation IDs | P0 | `packages/backend/src/common/logger/*` | `packages/backend/test/logger-redaction.spec.ts` | Planned |
| `FR-EXEC-009` | Attachment adapter (S3/MinIO) with size and checksum validation | P1 | `packages/core/src/attachments/attachment-adapter.ts` | `packages/core/test/attachment.spec.ts` | Planned |
| `FR-EXEC-010` | CDC / incremental synchronization architecture hooks | P2 | `packages/core/src/cdc/cdc-stub.ts` | Unit tests | Planned |

### 1.7 Validation & Assurance (FR-VAL)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-VAL-001` | Record count reconciliation with scope/exclusions | P0 | `packages/core/src/validator/count-validator.ts` | `packages/core/test/count-validator.spec.ts` | Planned |
| `FR-VAL-002` | Reconcile key-sets: missing, extra, duplicate records | P0 | `packages/core/src/validator/keyset-validator.ts` | `packages/core/test/keyset-validator.spec.ts` | Planned |
| `FR-VAL-003` | Content hash comparison over canonicalized fields | P0 | `packages/core/src/validator/content-hash-validator.ts` | `packages/core/test/hash-validator.spec.ts` | Planned |
| `FR-VAL-004` | Parent-child relationship and foreign key integrity | P0 | `packages/core/src/validator/relationship-validator.ts` | `packages/core/test/relationship-validator.spec.ts` | Planned |
| `FR-VAL-005` | Attachment presence and checksum verification | P0 | `packages/core/src/validator/attachment-validator.ts` | `packages/core/test/attachment-validator.spec.ts` | Planned |
| `FR-VAL-006` | Configured metadata comparison | P0 | `packages/core/src/validator/metadata-validator.ts` | `packages/core/test/metadata-validator.spec.ts` | Planned |
| `FR-VAL-007` | Discrepancy persistence (category, severity, identifiers, evidence) | P0 | `packages/backend/src/validation/discrepancy.service.ts` | `packages/backend/test/discrepancy.spec.ts` | Planned |
| `FR-VAL-008` | Export CSV and HTML reports | P0 | `packages/core/src/reports/report-generator.ts` | `packages/core/test/report-generator.spec.ts` | Planned |
| `FR-VAL-009` | AI groups discrepancies & suggests root causes (linked to IDs) | P1 | `packages/backend/src/ai/agents/discrepancy-investigator.agent.ts` | `packages/backend/test/ai-agents.spec.ts` | Planned |
| `FR-VAL-010` | AI proposes remediation steps (allowlisted, requires approval) | P1 | `packages/backend/src/ai/agents/repair-planner.agent.ts` | `packages/backend/test/repair-planner.spec.ts` | Planned |

### 1.8 AI Copilot & Agent Workflows (FR-AI)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-AI-001` | Natural language Copilot citing internal evidence | P1 | `packages/backend/src/ai/agents/copilot.agent.ts` | `packages/backend/test/copilot.spec.ts` | Planned |
| `FR-AI-002` | Planner restricted to read-only tools; cannot execute runs | P1 | `packages/backend/src/ai/tools/allowlist.ts` | `packages/backend/test/ai-tool-guard.spec.ts` | Planned |
| `FR-AI-003` | Validate all AI outputs against strict versioned schemas | P1 | `packages/backend/src/ai/schemas/*` | `packages/backend/test/ai-schema-validation.spec.ts` | Planned |
| `FR-AI-004` | Allowlisted workspace-scoped AI tools with permission checks | P1 | `packages/backend/src/ai/tools/*` | `packages/backend/test/ai-tools.spec.ts` | Planned |
| `FR-AI-005` | Data minimization: metadata, aggregates, masked samples only | P1 | `packages/backend/src/ai/masking/*` | `packages/backend/test/data-masking.spec.ts` | Planned |
| `FR-AI-006` | Persist AI traces (model, prompt version, tool calls, latency) | P1 | `packages/backend/src/ai/trace.service.ts` | `packages/backend/test/ai-trace.spec.ts` | Planned |
| `FR-AI-007` | Core app fully functional with AI disabled | P1 | `packages/backend/src/ai/ai.module.ts` | `packages/backend/test/ai-disabled.spec.ts` | Planned |

### 1.9 Recovery, Reporting & Audit (FR-REC)
| Req ID | Requirement Summary | Priority | Target Location | Test Coverage | Status |
|---|---|---|---|---|---|
| `FR-REC-001` | Resume from last committed checkpoint without duplicates/skipped | P0 | `packages/worker/src/engine/checkpoint.ts` | `packages/worker/test/checkpoint-resume.spec.ts` | Planned |
| `FR-REC-002` | Error classification into retryable, permanent, unknown | P0 | `packages/worker/src/engine/error-classifier.ts` | `packages/worker/test/error-classifier.spec.ts` | Planned |
| `FR-REC-003` | Migration run lifecycle and audit timeline | P0 | `packages/backend/src/audit/timeline.service.ts` | `packages/backend/test/timeline.spec.ts` | Planned |
| `FR-REC-004` | Immutable append-only audit events for privileged actions | P0 | `packages/backend/src/audit/audit.service.ts` | `packages/backend/test/audit.spec.ts` | Planned |
| `FR-REC-005` | Export comprehensive run report with validation evidence | P0 | `packages/core/src/reports/*` | `packages/core/test/reports.spec.ts` | Planned |
| `FR-REC-006` | Scoped recovery plan generation | P1 | `packages/backend/src/plan/recovery-plan.service.ts` | `packages/backend/test/recovery.spec.ts` | Planned |

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

---

## 3. Implementation Phases Progress
- [ ] **Phase 0:** Repository & Architecture Setup, Docker, Shared Core, Tracker
- [ ] **Phase 1:** Core Connectors, Mapping DSL, Migration Engine, Checkpointing & Recovery
- [ ] **Phase 2:** Deterministic Validation Engine & Fault Injection Demonstration
- [ ] **Phase 3:** AI Agents (Planner, Mapping, Risk, Failure Investigator, Discrepancy Investigator, Copilot)
- [ ] **Phase 4:** Enterprise Next.js Frontend Console
- [ ] **Phase 5:** End-to-End Testing, Hardening & Verification
