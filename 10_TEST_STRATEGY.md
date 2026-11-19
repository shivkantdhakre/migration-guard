# Test Strategy and Quality Plan

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Proposed baseline

## 1. Quality objectives

Prove that MigrationGuard moves supported data correctly, preserves committed progress on worker failure, avoids duplicates on retry, detects seeded defects, enforces permissions, keeps AI within its boundary and produces reproducible evidence.

## 2. Test levels

### Unit tests

- Transformation operations and edge cases.
- Canonicalization and hashing.
- Error classification.
- Run/batch/approval state transitions.
- Plan and mapping schema validation.
- Authorization helper functions.
- AI output parser and operation allowlist.

### Integration tests

- MongoDB connector against a test MongoDB instance.
- PostgreSQL connector against a test PostgreSQL instance.
- Redis/BullMQ enqueue, retry and redelivery.
- Object-storage upload and checksum verification.
- Control DB transaction/checkpoint behavior.
- AI provider adapter with mocks and controlled fixtures.

### End-to-end tests

Create project/connections → discover schemas → create mapping → preview/dry-run → approve → migrate → interrupt/restart → validate → export report.

### Non-functional tests

Load/throughput, bounded-memory streaming, queue recovery, fault injection, tenant isolation, security and accessibility.

## 3. Synthetic acceptance dataset

Create a versioned generator with reproducible seed. Baseline fixture:

- 10,000 customer/document records.
- Stable source IDs.
- Embedded addresses and orders.
- Parent-child references.
- Multiple supported timestamp formats.
- Optional binary attachment references.
- Metadata and sample audit-event history.

Save a manifest of expected source keys, counts, relationships and attachment hashes.

## 4. Fault-injection scenario

After a clean migration, introduce controlled discrepancies:

| Injected defect | Count | Expected check |
|---|---:|---|
| Missing attachments | 15 | Attachment presence/checksum |
| Duplicate records | 10 | Duplicate key/business-key check |
| Broken references | 8 | Relationship validation |
| Metadata mismatches | 12 | Configured metadata comparison |
| **Total** | **45** | **45 seeded discrepancy instances under the chosen category rules** |

Acceptance:

- Every injected defect maps to a known source/destination key.
- Validator detects each defect in the intended category.
- No defect is double-counted unless policy deliberately emits multiple findings.
- Report totals match persisted discrepancy rows.
- AI may cluster defects but cannot alter deterministic counts.

## 5. Transformation test matrix

| Case | Input | Expected behavior |
|---|---|---|
| ObjectId | BSON ObjectId | Preserve/encode according to rule |
| Decimal128 | High precision number | Preserve supported precision or emit explicit precision warning/error |
| Date | BSON date / ISO string | Normalize to configured timestamp semantics |
| Null vs missing | Missing field | Apply explicit policy; do not silently collapse meaningful distinction |
| Nested object | Address object | JSONB or configured child columns |
| Embedded array | Orders array | Child rows with stable relationship mapping |
| Invalid date | Malformed string | Row-level conversion error |
| Oversize record | Above configured limit | Explicit oversized-record failure |
| Unicode | Composed/decomposed text | Follow documented canonicalization rule |

## 6. Failure/recovery matrix

| Injected failure | Expected result |
|---|---|
| Kill worker before read | Batch safely re-dispatched |
| Kill worker during read | Cursor range re-read |
| Kill worker during transform | Deterministic transform rerun |
| Kill worker after target commit | Reconcile or idempotently replay without duplicate effect |
| Kill after manifest before checkpoint | Reconcile and commit checkpoint |
| Redis unavailable | Durable state preserved; work can be re-dispatched |
| Source disconnect | Pause/fail with classified connector error |
| Target disconnect with unknown commit | Batch enters reconciliation, not blind retry |
| AI provider unavailable | Migration and validation continue |
| Duplicate queue delivery | Stable batch identity prevents duplicate effect |

## 7. API and authorization tests

- Unauthenticated request returns 401.
- Workspace A cannot read Workspace B resources.
- Viewer cannot edit mapping or start run.
- Stale approval hash cannot start a run.
- Invalid state transition returns conflict.
- Idempotency key prevents duplicate run creation.
- Connection secret never appears in response/log.
- Pagination is bounded and tenant-scoped.

## 8. AI adversarial tests

- Correct suggestion for obvious mappings.
- Planner asks when relationship semantics are ambiguous.
- Unknown transform operation is rejected.
- Prompt injection in field name/sample is treated as data.
- AI cannot invoke unlisted tools.
- AI cannot access another workspace's schema/logs.
- AI cannot mark validation passed.
- Arbitrary SQL/script repair proposal is rejected.
- Answers distinguish facts from hypotheses.
- Provider timeout and malformed output are handled safely.

## 9. Performance and load tests

Run 10k small records, 100k mixed-size records, near-limit large record, high-cardinality arrays, destination throttling, concurrent runs, and full validation. Record dataset, environment, versions, concurrency, batch size, elapsed time, CPU, memory, throughput and failures. Do not publish a benchmark without its environment and parameters.

## 10. Test-data rules

- Use synthetic data by default.
- Do not copy production records to dev/test without explicit authorization and masking.
- Reset target fixtures between runs.
- Preserve generator seed and expected manifest.
- Keep test credentials separate from production.
- Use containerized dependencies for repeatability.

## 11. Release gates

- All P0 functional tests pass.
- No known critical/high security defect remains open.
- Worker restart and unknown-commit tests pass.
- Seeded defects are detected and categorized.
- AI adversarial tests reject unsafe proposals.
- Core migration works with AI disabled.
- Report totals reconcile with persisted validation rows.
- Operational runbooks have been exercised in a staging environment.

## 12. Defect severity

- **Critical:** Data loss/corruption, cross-tenant access, unauthorized production write, credential leak.
- **High:** Incorrect validation pass, unsafe retry, lost checkpoint, primary migration path unavailable.
- **Medium:** Feature degradation or incorrect non-critical report/UX behavior.
- **Low:** Cosmetic/minor usability issue.
