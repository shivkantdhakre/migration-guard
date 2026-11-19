# Roadmap and Delivery Plan

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Proposed; sequencing matters more than calendar estimates

## 1. Delivery strategy

Build deterministic migration first, then AI planning and troubleshooting. Do not build a multi-agent system before connector, mapping, checkpoint and validation contracts are stable.

## 2. Workstreams

1. Product and UX foundations.
2. Control-plane API and data model.
3. Connectors and migration engine.
4. Validation and assurance.
5. AI orchestration and tools.
6. Security, observability and operations.
7. Demo dataset and automated testing.

## 3. Phase 0 — Product and technical foundation

**Exit:** Product boundary and core contracts reviewed; development environment and CI available.

Deliverables:

- Confirm supported MongoDB/PostgreSQL versions and topology.
- Define source consistency assumptions.
- Finalize workspace/resource authorization baseline.
- Define plan/mapping DSL v1 and connector interface.
- Define error taxonomy and state machine.
- Docker Compose environment with PostgreSQL, Redis, MongoDB and MinIO.
- Synthetic data generator and expected manifest.
- CI, linting, unit test framework and control DB migrations.

## 4. Phase 1 — Deterministic migration MVP

**Exit:** One supported source-target path works end-to-end with AI disabled.

Deliverables: auth/workspace model; connection and secret boundary; MongoDB reader; PostgreSQL writer; schema snapshots; mapping DSL; transform engine; preview/dry run; plan version and hash approval; BullMQ orchestration; batching, retries, checkpoint/resume; progress and sanitized logs.

## 5. Phase 2 — Validation and audit MVP

**Exit:** Platform detects seeded defects and emits traceable reports.

Deliverables: count/key reconciliation; duplicate detection; canonical content comparison; relationship checks; metadata comparison; attachment adapter for the selected demo path; discrepancy explorer; CSV/HTML reports; audit timeline; 10k defect-injection scenario; worker crash/recovery suite.

## 6. Phase 3 — AI Migration Copilot

**Exit:** AI creates useful reviewable drafts without direct production execution.

Deliverables: provider adapter; LangGraph planner; schema mapping suggestions; deterministic readiness findings plus AI narrative; tool authorization; structured output validation; AI traces; data masking/provider opt-out; evaluation and prompt-injection tests.

## 7. Phase 4 — AI investigation and guided remediation

**Exit:** AI explains failures and drafts bounded remediation proposals.

Deliverables: Failure Investigator; discrepancy clustering; allowlisted Repair Planner; dry-run repair pipeline; approval and audit; post-repair validation.

## 8. Phase 5 — Advanced capabilities

Potential scope: more connectors, CDC/incremental sync through established tools, schema drift monitoring, cutover workflow, vector ingestion, historical pattern retrieval, customer-side connector/private networking, quotas and enterprise deployment modes.

## 9. Suggested epics

### Epic A — Control plane

- A1 Workspace and roles.
- A2 Connection CRUD and secret boundary.
- A3 Projects/plans lifecycle.
- A4 Audit event service.
- A5 API error/idempotency conventions.

### Epic B — Schema and mapping

- B1 MongoDB discovery.
- B2 PostgreSQL discovery.
- B3 Snapshot persistence.
- B4 Profile aggregates.
- B5 Mapping DSL.
- B6 Transformation engine.
- B7 Preview/dry run.

### Epic C — Migration execution

- C1 Queue/worker bootstrap.
- C2 Source batch reader.
- C3 Destination writer.
- C4 Batch manifest.
- C5 Checkpoint state machine.
- C6 Retry and unknown-outcome handling.
- C7 Progress aggregation.

### Epic D — Validation

- D1 Count reconciliation.
- D2 Key reconciliation.
- D3 Duplicate detection.
- D4 Canonicalization/hash.
- D5 Relationship validation.
- D6 Metadata check.
- D7 Attachment verification.
- D8 Discrepancy persistence/report.

### Epic E — AI

- E1 Provider adapter.
- E2 Context retrieval tools.
- E3 Planner graph.
- E4 Mapping suggestions.
- E5 Failure investigator.
- E6 Structured output validation.
- E7 AI traces/evals.
- E8 Repair proposal workflow.

### Epic F — Hardening

- F1 Tenant isolation tests.
- F2 Secret redaction tests.
- F3 Fault injection.
- F4 Load tests.
- F5 Deployment automation.
- F6 Backup/restore runbook.

## 10. Critical path

`Connector contracts → Schema snapshots → Mapping DSL → Deterministic transforms → Batch execution → Checkpoint/recovery → Validation → Reports`

AI planner depends on snapshots, mapping DSL, connector capabilities and plan validator. AI troubleshooting depends on persisted run logs and discrepancy evidence. Do not start repair automation before deterministic validation and approval are stable.

## 11. Definition of Ready

A backlog item has a user outcome, scope, FR/NFR IDs, API/data contract impact, acceptance criteria, permissions/error behavior, tests and dependencies.

## 12. Definition of Done

Implementation and tests are merged; docs updated; operational logs/metrics exist; security checks are included; error paths are handled; demo/test evidence exists; no P0/P1 acceptance item is silently deferred.

## 13. Delivery risks

| Risk | Response |
|---|---|
| Scope creep across connectors | Build one thin end-to-end vertical slice |
| Ambiguous mapping semantics | Ask explicit user questions; do not guess |
| Checkpoint complexity underestimated | Add fault-injection tests early |
| AI distracts from reliability | AI workstream depends on stable core contracts |
| Validation cost grows | Partition and label check coverage honestly |
| CDC delays MVP | Defer and integrate established tooling later |
| Enterprise security expands | Choose initial deployment model before pilot |

## 14. First vertical slice

Implement one MongoDB collection with stable `_id` and a few scalar fields:

1. Connect source and target.
2. Discover schemas.
3. Map fields manually.
4. Preview transformation.
5. Migrate 1,000 records in batches.
6. Kill/restart worker and verify resume.
7. Validate counts, keys and hashes.
8. Export a basic report.

Only after this works should the team add embedded arrays, attachments and AI planning.
