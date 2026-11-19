# Operations Runbooks

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Initial operational procedures

## 1. Operational principles

- Never manually edit checkpoint rows to force a run forward.
- Never retry an unknown destination write outcome blindly.
- Preserve logs, run IDs and audit evidence before changing state.
- Pause affected workers before changing connection credentials or plan configuration.
- A run is not fully complete until required validation is complete.
- Use approved platform actions and record each intervention.

## 2. Health indicators

Monitor API liveness/readiness, control DB connectivity, Redis health, worker heartbeat, queue depth/oldest job age, active runs, object storage connectivity and optional model-provider health. A model-provider outage should not make deterministic product functions unhealthy.

## 3. Runbook: migration queue backlog

**Symptoms:** Queue depth grows, runs stay queued, oldest job age increases.

1. Check Redis health, memory and eviction events.
2. Check worker process health and recent deployment changes.
3. Inspect concurrency limits and connector pool saturation.
4. Check source/destination availability and throttling.
5. Confirm one workload type is not blocking another queue.
6. Scale only the relevant worker pool and only within DB capacity limits.
7. Record affected run IDs and incident timeline.

Do not increase concurrency blindly; it may worsen database throttling.

## 4. Runbook: worker crashed during migration

1. Identify worker, run ID, batch ID and last heartbeat.
2. Check batch state: `RUNNING`, `DESTINATION_WRITTEN`, `MANIFEST_COMMITTED` or `COMMITTED`.
3. Inspect destination using batch idempotency/stable keys.
4. If outcome is known and idempotent, allow safe re-dispatch.
5. If outcome is unknown and operation is not idempotent, hold for reconciliation.
6. Restart worker after root cause is understood.
7. Verify checkpoint and batch counters.
8. Run validation for the affected scope.

## 5. Runbook: source connection failure

1. Pause scheduling of new batches.
2. Check source availability, DNS, TLS, firewall, credential validity and source load.
3. Run connection test.
4. Rotate credentials if expired or compromised.
5. Confirm source cursor/read-consistency boundary is still valid.
6. Resume only after connectivity and cursor semantics are verified.
7. If source boundary cannot be guaranteed, create a new run or require controlled re-baselining.

## 6. Runbook: destination connection failure

1. Pause the run.
2. Determine whether in-flight writes may have committed.
3. Inspect batch state and destination stable keys.
4. Reconcile unknown outcomes before retry.
5. Check permissions, locks, storage capacity and constraints.
6. Do not disable constraints as an undocumented workaround.
7. Resume only when write-mode idempotency is understood.
8. Re-run validation for affected partitions.

## 7. Runbook: validation reports many discrepancies

1. Confirm correct source/destination connection versions were used.
2. Confirm mapping and canonicalization versions match the run.
3. Group discrepancies by batch, source partition and transform rule.
4. Inspect a representative sample of evidence.
5. Check for false positives from timezone/date, numeric precision, null/missing or array-order semantics.
6. Do not suppress a category until its comparison rule is reviewed and versioned.
7. If mapping defect is confirmed, create a new mapping version and controlled repair/reprocess plan.
8. Revalidate and retain prior failed result for audit history.

## 8. Runbook: AI provider unavailable

1. Confirm provider outage/rate limiting.
2. Stop repeated retries for persistent errors.
3. Show AI as degraded.
4. Continue manual mapping, migration, deterministic validation and report export.
5. Resume AI workflows after provider health returns; check existing workflow state to avoid duplicate proposals.

## 9. Runbook: suspicious AI output or tool request

1. Stop the workflow and retain trace metadata.
2. Do not execute proposed action.
3. Check output schema and policy rejection details.
4. Review whether untrusted source content influenced the prompt.
5. Verify server-side tool authorization.
6. Add the case to the evaluation suite.
7. Re-enable only after fix and regression test.

## 10. Runbook: credential exposure

1. Revoke/rotate exposed credential immediately.
2. Disable connection and pause runs using it.
3. Identify where secret appeared: logs, traces, prompt, report or API response.
4. Restrict affected artifacts and preserve incident evidence.
5. Purge exposed artifacts under incident/retention policy where possible.
6. Review access logs for misuse.
7. Notify security owner and follow contractual/legal policy.
8. Add redaction regression test before restoring connection.

## 11. Runbook: report generation failure

1. Confirm validation run remains intact.
2. Check report worker and object storage.
3. Inspect sanitized error and report template version.
4. Retry with idempotency key.
5. Ensure incomplete artifact is not exposed as final report.
6. Verify checksum and access control after success.

## 12. Backup and restore checklist

Before production, define control DB backup frequency/retention, encrypt backups, include audit and plan/mapping versions, document secret-manager recovery, test restore in isolation and reconcile restored run state with actual destination state before resuming jobs. Verify object-store artifact references and checksums. Control DB backups are not backups of customer data.

## 13. Incident record template

```text
Incident ID:
Severity:
Detected at (UTC):
Affected workspace(s):
Affected run(s):
Source/destination systems:
Observed symptoms:
Last known committed batch/checkpoint:
Potential data impact:
Actions taken:
Evidence locations:
Communication owner:
Root cause:
Corrective actions:
Follow-up tests:
Resolved at (UTC):
```

## 14. Release checklist

- [ ] API and workers deploy with compatible API/schema versions.
- [ ] Secret manager configuration verified.
- [ ] DB migrations applied and backup available.
- [ ] Redis and worker queues healthy.
- [ ] Source/destination connectivity tested.
- [ ] Pause/resume exercised in staging.
- [ ] Unknown-outcome handling tested.
- [ ] Validation and report generation tested.
- [ ] AI can be disabled independently.
- [ ] Audit events visible for privileged operations.
