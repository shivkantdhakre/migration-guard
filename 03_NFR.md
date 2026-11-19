# Non-Functional Requirements (NFR)

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Draft

## 1. Purpose

These requirements define quality attributes and operating constraints. Targets are initial design objectives for a controlled MVP environment, not guarantees for arbitrary customer infrastructure. Validate them with repeatable load and failure tests.

## 2. Performance and capacity

| ID | Requirement | Initial target / verification |
|---|---|---|
| NFR-PERF-001 | Control-plane metadata reads remain responsive while workers run. | Target p95 under 500 ms in demo environment, excluding external dependency latency. |
| NFR-PERF-002 | Bulk movement uses bounded streaming memory. | Memory stays under configured worker limit in 100k-record mixed-size test. |
| NFR-PERF-003 | Batch size/concurrency are configurable within server-side limits. | Invalid/excessive values are rejected. |
| NFR-PERF-004 | Progress does not require rescanning all source records. | Derived from batch manifests/counters and updated at configured interval. |
| NFR-PERF-005 | Validation is partitionable and can report partial completion. | Partition/check results persist independently. |
| NFR-PERF-006 | AI calls do not block migration workers. | AI work runs asynchronously with bounded timeout/retry. |

### Initial configuration defaults

- Batch size: 1,000 records, also bounded by payload bytes.
- Worker concurrency: 2 per run.
- Maximum record size: deployment-configurable; oversize records fail explicitly.
- AI mapping context: no more than 20 masked sample examples by default.
- AI request timeout: 30 seconds by default.
- Transient AI retries: at most 2 by default.

These defaults must be configurable by deployment policy and tested against source/destination limits.

## 3. Reliability and availability

- **NFR-REL-001:** Run state and checkpoints persist in PostgreSQL, not worker memory only.
- **NFR-REL-002:** Workers tolerate restart and queue redelivery.
- **NFR-REL-003:** Batch commits only after destination writes and required manifest/checkpoint state are durable.
- **NFR-REL-004:** Failure between target write and control-plane checkpoint is recoverable by idempotency or reconciliation.
- **NFR-REL-005:** Queue outage does not erase durable run state; eligible work can be re-dispatched.
- **NFR-REL-006:** AI outage does not block deterministic migration, validation or reports.
- **NFR-REL-007:** Unknown destination commit outcomes are distinct from definite failures.
- **NFR-REL-008:** Validation preserves partial results when feasible.

Do not promise distributed exactly-once semantics across independent databases and object storage. Use at-least-once processing with idempotent effects for supported operations.

## 4. Scalability

- Scale worker pools independently, subject to connector and database limits.
- Set run-level and connection-level concurrency limits.
- Queue payloads contain IDs and metadata, never bulk source records.
- Schema discovery/profiling are bounded and paginated.
- Large discrepancy lists use indexed filters and cursor pagination.
- Allow separate worker pools for migration, validation, AI and reports.
- Add tenant quotas/fair scheduling before external multi-tenant scale.

## 5. Security

- **NFR-SEC-001:** Credentials are stored encrypted or in a managed secret store; never plaintext in application tables.
- **NFR-SEC-002:** External connections use TLS where supported.
- **NFR-SEC-003:** Server enforces workspace/project/resource authorization on every request/tool.
- **NFR-SEC-004:** Database credentials use least privilege; source is read-only where possible.
- **NFR-SEC-005:** Logs, traces, reports and AI prompts redact secrets and configured sensitive fields.
- **NFR-SEC-006:** AI tools use typed allowlisted operations; no arbitrary SQL/shell execution.
- **NFR-SEC-007:** Production-impacting operations require configured approvals.
- **NFR-SEC-008:** Approvals and privileged actions are audited.

See `09_SECURITY_PRIVACY_THREAT_MODEL.md`.

## 6. Privacy and data minimization

- Default AI context uses schema metadata, aggregate profiles, error codes and masked samples.
- Raw record values are not sent to external models by default.
- Workspace administrator can disable external AI processing.
- Raw sample transmission requires explicit policy and UI disclosure.
- Retention is configurable for logs, profiles, temporary files, reports and AI traces.
- Avoid temporary extracted data; where required, encrypt, restrict and delete on schedule.

## 7. Maintainability and extensibility

- Connector implementations follow stable interfaces and capability descriptors.
- Transformation operations are deterministic and versioned.
- API, plan, mapping and validation profile schemas are versioned independently.
- Model providers are replaceable through an adapter.
- Vendor SDKs remain isolated from domain services.
- Connector contracts and each transform operation have automated tests.
- State transitions are centralized and validated.

## 8. Usability and accessibility

- Do not use color alone to communicate state.
- Errors provide code, summary, affected scope and next step where possible.
- Production/destructive actions require confirmation.
- AI proposals can be inspected before acceptance.
- Core workflows support keyboard navigation and accessible labels.
- Timestamps show timezone context.

## 9. Observability

Emit structured logs, metrics and traces with correlation IDs. Minimum metrics:

- Queue depth and oldest job age.
- Active/completed/failed jobs by worker pool.
- Batch throughput and latency.
- Source read and destination write latency.
- Retry/permanent failure counts.
- Last committed checkpoint age.
- Validation duration and discrepancy count by category.
- AI latency, error rate and usage/cost where available.
- Worker CPU and memory.

Do not use secrets, raw payloads or direct customer identifiers as metric labels.

## 10. Portability and deployment

- Local development supports containerized PostgreSQL, Redis and MinIO.
- Production separates API and workers.
- Configuration is environment-driven and validated at startup.
- Secrets are injected via a secret manager or secure deployment mechanism.
- Internal database migrations are versioned and reversible where practical.

## 11. Backup and disaster recovery

- Back up control-plane metadata and audit records.
- Define recovery point/time objectives for the deployment.
- Encrypt backups and test restores.
- MigrationGuard metadata backup is not a backup of customer source or destination data.
- After control-plane restore, reconcile external destination state before resuming jobs.

## 12. Compliance posture

The MVP provides security and audit controls but must not claim SOC 2, ISO 27001, GDPR, HIPAA or other certification/compliance status without formal legal, technical and independent assessment. Data residency and deletion requirements depend on the deployment model.
