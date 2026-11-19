# Functional Requirements Document (FRD)

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Draft  
**Related:** `01_PRD.md`, `04_SYSTEM_ARCHITECTURE.md`, `06_API_SPEC.md`

## 1. Purpose and conventions

This document translates product goals into testable requirements. **P0** means required for MVP, **P1** means important follow-on, and **P2** means later capability. Unless otherwise stated, requirements apply to the MongoDB-to-PostgreSQL path and the current user's authorized workspace.

## 2. Roles

| Role | Permissions |
|---|---|
| Workspace Owner | Manage workspace, members, policies, projects and connections |
| Migration Admin | Create/edit plans, approve and execute runs, manage projects |
| Migration Engineer | Inspect schemas, create mappings, run previews and execute when authorized |
| Auditor / Viewer | Read run status, validation evidence and reports |
| Platform Operator | Pause/resume/requeue operational work under explicit grant and audit |

MVP may simplify the role set, but authorization must be enforced server-side and scoped to each resource.

## 3. Functional requirements

### 3.1 Identity and workspace

- **FR-IAM-001 (P0):** Authenticate users before exposing workspace data. **Acceptance:** Protected API returns `401` when unauthenticated.
- **FR-IAM-002 (P0):** Scope projects, connections, runs, reports and audit events to authorized workspaces. **Acceptance:** User from Workspace A cannot access Workspace B by changing an ID in a request.
- **FR-IAM-003 (P1):** Support read-only auditor access. **Acceptance:** Viewer can read evidence but cannot edit mappings, start runs or approve repairs.

### 3.2 Connection management

- **FR-CON-001 (P0):** Create named source/destination connection profiles. **Acceptance:** Secret material is not included in ordinary metadata responses.
- **FR-CON-002 (P0):** Test connectivity and required permissions. **Acceptance:** Return sanitized outcome, capability results and test timestamp; never return credentials.
- **FR-CON-003 (P0):** Support MongoDB source and PostgreSQL destination. **Acceptance:** Valid connections complete schema discovery and bounded read/write tests in a controlled target.
- **FR-CON-004 (P0):** Rotate credentials. **Acceptance:** Increment credential/config version; new runs use the current version while active runs retain explicit version references.
- **FR-CON-005 (P1):** Reuse multiple connection profiles across projects under workspace policy.

### 3.3 Schema discovery and profiling

- **FR-SCH-001 (P0):** Discover MongoDB databases, collections, field paths and observed BSON types. **Acceptance:** Persist discovery time, connection version, sampling method and observed type distribution.
- **FR-SCH-002 (P0):** Inspect PostgreSQL schemas, tables, columns, types, nullability, primary keys and foreign keys.
- **FR-SCH-003 (P0):** Profile a bounded configurable sample. **Acceptance:** Report null frequency, type variation, observed formats, sample count and limitations.
- **FR-SCH-004 (P0):** Flag incompatible types, required target fields without source values, and potential truncation/precision loss.
- **FR-SCH-005 (P1):** Compare immutable schema snapshots and show added, removed and changed fields.

### 3.4 Mapping and transformation

- **FR-MAP-001 (P0):** Map source paths to destination columns or JSON fields. Save as a versioned mapping configuration.
- **FR-MAP-002 (P0):** Provide deterministic transformations: rename, supported casts/parsers, null/default handling, date normalization, string normalization, flattening, JSONB preservation and explicitly configured array-to-child-table mapping.
- **FR-MAP-003 (P0):** Validate mapping DSL before preview or execution. Unsupported operations, missing target fields and incompatible types must block execution.
- **FR-MAP-004 (P0):** Preview transformed sample records without writing to production tables. Show conversion warnings and rejected rows.
- **FR-MAP-005 (P0):** Preserve source-to-destination ID correspondence when identifiers change. ID mappings are scoped to a migration run and source object.
- **FR-MAP-006 (P1):** AI proposes field mappings with rationale, assumptions and confidence as advisory metadata. It cannot overwrite accepted rules silently.
- **FR-MAP-007 (P1):** AI proposes transformations for ambiguous structures; every proposal requires a sample test and user review.

### 3.5 Planning and approval

- **FR-PLAN-001 (P0):** Create a migration plan linking source/destination connection versions, schema snapshots and mapping version.
- **FR-PLAN-002 (P0):** Plan defines selected objects, scope, identity strategy, batch size, concurrency, write mode, retry policy and validation profile.
- **FR-PLAN-003 (P0):** Provide dry run against a bounded sample or isolated target; it must not mutate production data.
- **FR-PLAN-004 (P0):** Require approval before a production run. Approval references exact plan version and canonical hash.
- **FR-PLAN-005 (P1):** AI drafts a migration plan from natural-language requirements and authorized metadata. Output must conform to a strict schema and remain non-executable until reviewed.
- **FR-PLAN-006 (P1):** Generate readiness report distinguishing measured facts, rule-based findings and AI hypotheses.

### 3.6 Migration execution

- **FR-EXEC-001 (P0):** Start approved plans asynchronously and return a run ID.
- **FR-EXEC-002 (P0):** Read/write bounded batches with configured concurrency. Bulk record payloads must not be stored in queue messages.
- **FR-EXEC-003 (P0):** Persist stable batch ID, sequence, state, cursor/range, attempts and read/write/skip/failure counts.
- **FR-EXEC-004 (P0):** Retry only bounded transient failures. Permanent data errors require review.
- **FR-EXEC-005 (P0):** Support pause/resume. Pause stops scheduling new batches; in-flight behavior is explicit.
- **FR-EXEC-006 (P0):** Make supported destination writes idempotent. Reprocessing the same source key under the same plan/run must not create unintended duplicates.
- **FR-EXEC-007 (P0):** Expose records processed, succeeded, failed, skipped, retry counts, throughput, state and last update.
- **FR-EXEC-008 (P0):** Store sanitized run/batch logs with correlation IDs; redact credentials and configured sensitive values.
- **FR-EXEC-009 (P1):** Support attachment adapter with source/destination references, size, content type and checksum state.
- **FR-EXEC-010 (P2):** Support CDC through database-native or established technology; CDC offsets must be distinct from snapshot checkpoints.

### 3.7 Validation and assurance

- **FR-VAL-001 (P0):** Compare expected/actual record counts with scope and exclusions documented.
- **FR-VAL-002 (P0):** Reconcile stable keys or ID mappings and classify missing, extra and duplicate records separately.
- **FR-VAL-003 (P0):** Compare normalized content for configured fields; record exact canonicalization version and compared field set.
- **FR-VAL-004 (P0):** Validate configured relationships and identify affected source and destination keys.
- **FR-VAL-005 (P0):** Verify attachment presence and checksum where adapter supports it; distinguish missing, size mismatch and hash mismatch.
- **FR-VAL-006 (P0):** Compare configured metadata fields with safe evidence references and field-level results.
- **FR-VAL-007 (P0):** Persist discrepancy category, severity, affected identifiers, check ID, evidence reference, status and timestamp.
- **FR-VAL-008 (P0):** Generate CSV and HTML reports with scope, checks, totals, exceptions and methodology/version.
- **FR-VAL-009 (P1):** AI groups discrepancies and suggests root causes; every cluster links to the original discrepancy IDs and is labeled as a hypothesis.
- **FR-VAL-010 (P1):** AI proposes remediation steps. Dry run, allowlist validation and approval are required before production action.

### 3.8 AI copilot and agent workflows

- **FR-AI-001 (P1):** Let users ask questions about authorized projects/runs. Answers cite internal evidence references and distinguish facts from hypotheses.
- **FR-AI-002 (P1):** Planner uses read-only schema/profile tools to draft a plan; it cannot start a run.
- **FR-AI-003 (P1):** Validate all AI output against versioned schemas. Invalid output is rejected or receives one bounded correction attempt.
- **FR-AI-004 (P1):** AI tools are allowlisted and workspace-scoped; each invocation independently checks permissions.
- **FR-AI-005 (P1):** Default AI context is metadata, aggregates, masked samples and sanitized errors. Raw samples require explicit policy.
- **FR-AI-006 (P1):** Persist model/provider, prompt and graph versions, tool calls (redacted), output schema version, latency and usage metadata where available.
- **FR-AI-007 (P1):** Core mapping, migration, validation and report export work with AI disabled.

### 3.9 Recovery, reporting and audit

- **FR-REC-001 (P0):** Resume from last committed checkpoint. Restart tests must prove no unintended duplicate or skipped records.
- **FR-REC-002 (P0):** Distinguish retryable, permanent and unknown-outcome failures using connector error rules, not LLM judgment.
- **FR-REC-003 (P0):** Provide timeline for creation, approval, start, pause/resume, batches, validation and terminal state.
- **FR-REC-004 (P0):** Append audit events for approvals, configuration changes and privileged operations.
- **FR-REC-005 (P0):** Export run report containing plan hash, connector versions, counts, validation status and unresolved exceptions.
- **FR-REC-006 (P1):** Generate scoped recovery/rollback plan listing prerequisites, snapshots, affected objects and limitations. Never promise universal rollback.

## 4. Core workflows

### 4.1 Connection and discovery

1. User creates connection and submits credentials through secure input.
2. Backend stores secret in secret boundary and stores only reference/version in application metadata.
3. Connector tests network and permissions.
4. Discovery worker inspects metadata and bounded samples.
5. Immutable schema snapshot and sanitized discovery result are persisted.
6. Optional profiler reads bounded samples or safe aggregates.

Failure messages must be sanitized. Connection strings and passwords must never be logged.

### 4.2 Mapping

1. User selects source/target objects.
2. User maps manually or requests AI suggestions.
3. AI returns structured proposal with rationale and unresolved questions.
4. Backend checks fields and operations against discovered schemas and allowlist.
5. User accepts/edits proposal into a new mapping version.
6. Preview executes on bounded sample data.
7. Mapping version is immutable once referenced by an approved plan.

### 4.3 Migration

1. User creates plan and selects mapping version.
2. Readiness checks and dry run execute.
3. User reviews warnings and approves exact plan hash.
4. API creates run and dispatches coordinator.
5. Workers extract, transform, write and persist manifests/checkpoints.
6. Progress is observable; pause/resume/cancel obey run state machine.
7. Run reaches `MIGRATED`, `FAILED`, `CANCELLED` or `NEEDS_ATTENTION`.
8. Validation is a separate activity; migrated is not synonymous with validated.

### 4.4 Validation

1. User starts validation for a migration run/scope.
2. Validator loads exact plan, mapping, validation profile and canonicalization versions.
3. Reconcile counts and stable keys.
4. Run content, relationship, metadata and attachment checks where configured.
5. Persist check results and discrepancy records.
6. Optional AI analysis groups issues and explains likely causes.
7. User reviews, exports or initiates an approved repair workflow.

### 4.5 AI-assisted repair

1. AI reads sanitized discrepancy evidence and proposes allowlisted operation.
2. Backend validates operation, scope, plan and authorization.
3. User reviews exact affected objects and expected effects.
4. Run dry-run against fixture/staging or isolated transaction where supported.
5. Deterministic checks inspect proposed outcome.
6. Authorized user approves proposal hash.
7. Worker executes bounded action and records audit evidence.
8. New validation run verifies result.

## 5. State models

### Migration run

`DRAFT → READY → QUEUED → RUNNING → PAUSING → PAUSED → RUNNING → MIGRATED → VALIDATING → VALIDATED`

Other terminal/exception states: `FAILED`, `CANCELLED`, `NEEDS_ATTENTION`.

A run may be `MIGRATED` before validation completes. It is not fully assured until required checks pass under the configured policy.

### Batch

`PENDING → QUEUED → RUNNING → COMMITTED`

Branches: `RETRY_WAIT`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `OUTCOME_UNKNOWN`, `SKIPPED`, `CANCELLED`.

### Validation

`PENDING → RUNNING → COMPLETED`, or `PARTIAL`, `FAILED`, `CANCELLED`.

### Approval

`NOT_REQUIRED`, `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `REVOKED`. Any plan content change invalidates approval for the prior hash.

## 6. Validation categories and default severity

| Category | Example | Default severity |
|---|---|---|
| `MISSING_RECORD` | Source key absent in destination | Critical |
| `EXTRA_RECORD` | Destination key outside migration scope | High |
| `DUPLICATE_RECORD` | Duplicate destination business key | High |
| `CONTENT_MISMATCH` | Canonicalized values differ | High |
| `ATTACHMENT_MISSING` | Referenced object absent | High |
| `ATTACHMENT_CHECKSUM_MISMATCH` | Object hash differs | Critical |
| `BROKEN_REFERENCE` | Destination relation points to missing parent | Critical |
| `METADATA_MISMATCH` | Configured metadata differs | Medium/configurable |
| `TYPE_CONVERSION_ERROR` | Value could not be converted | High |
| `VALIDATION_SKIPPED` | Check could not run | Informational/review |

A skipped check must never count as passed.

## 7. Business rules

- **BR-001:** Only approved plan versions can start production runs.
- **BR-002:** Plan changes invalidate approval.
- **BR-003:** Checkpoint means destination effects and required manifest are durably accounted for.
- **BR-004:** Retries use stable batch identity or explicit versioned attempt identity.
- **BR-005:** Validation records exact mapping and canonicalization versions.
- **BR-006:** AI recommendations remain drafts until authorized acceptance.
- **BR-007:** AI repair requires allowlist validation, dry run and approval.
- **BR-008:** `MIGRATED` and `VALIDATED` are distinct states.
- **BR-009:** Matching counts alone cannot pass a validation profile.
- **BR-010:** A check not run is `SKIPPED` or `NOT_RUN`, never `PASS`.

## 8. UI requirements

- **Overview:** active runs, source/target, status, processed/success/failure counts, throughput, last update, validation status.
- **Schema explorer:** objects, fields, observed types, constraints, profile statistics and snapshot timestamp.
- **Mapping studio:** source/target path, transform operation, warnings, AI rationale, preview and version.
- **Run detail:** timeline, batches, counters, error class, retry state and checkpoint.
- **Validation center:** filters by category, severity, status, batch and key; view evidence and comparison methodology.
- **AI copilot:** distinguish facts, hypotheses and proposals; link statements to internal evidence.

## 9. MVP acceptance criteria

1. Configure MongoDB and PostgreSQL without exposing credentials.
2. Discover and persist source/target schemas.
3. Create, version, preview and approve a mapping.
4. Migrate a 10,000-record synthetic fixture in batches.
5. Kill/restart a worker without losing committed progress or creating unintended duplicates.
6. Detect seeded missing records, duplicates, content errors, broken references and configured metadata mismatches.
7. Link each discrepancy to validation run and affected key.
8. Export CSV and HTML reports.
9. Disable AI while retaining mapping, execution, validation and reporting.
10. Link each production run to approved plan hash and audit history.
