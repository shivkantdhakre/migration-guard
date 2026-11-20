# MigrationGuard — Queue & Worker Evidence
**Run Correlation Identifier:** `MG-E2E-20261120-001`  
**PostgreSQL Migration Run UUID:** `36988c91-405c-41fe-9919-e01377cf0033`  
**Audit Verification Date:** 20 November 2026  

---

## 1. Producer-Side BullMQ Queue Operations (VERIFIED)

- **Queue Name:** `migration-execution`
- **Broker Target:** Aiven Valkey Redis Cloud (`valkey-137cc70c-*.aivencloud.com:15678`, TLS)
- **Producer Client:** `bullmq.Queue` initialized in execution runner
- **Total BullMQ Jobs Dispatched:** `15` jobs
- **Dispatched Job ID Sequence:**
  - `MG-E2E-20261120-001_batch_cust_001`
  - `MG-E2E-20261120-001_batch_cust_002`
  - `MG-E2E-20261120-001_batch_cust_003`
  - `MG-E2E-20261120-001_batch_cust_004`
  - `MG-E2E-20261120-001_batch_ord_005`
  - `MG-E2E-20261120-001_batch_ord_006`
  - `MG-E2E-20261120-001_batch_ord_007`
  - `MG-E2E-20261120-001_batch_ord_008`
  - `MG-E2E-20261120-001_batch_ord_009`
  - `MG-E2E-20261120-001_batch_ord_010`
  - `MG-E2E-20261120-001_batch_ord_011`
  - `MG-E2E-20261120-001_batch_ord_012`
  - `MG-E2E-20261120-001_batch_ord_013`
  - `MG-E2E-20261120-001_batch_att_014`
  - `MG-E2E-20261120-001_batch_att_015`

All 15 jobs were accepted by Aiven Valkey Redis with confirmed Redis PING $\to$ PONG and unique deterministic BullMQ job IDs.

---

## 2. Independent Worker Daemon Consumption (UNVERIFIED IN THIS RUN)

### Precise Architectural Finding
- In this specific live-cloud run (`MG-E2E-20261120-001`), `scripts/run-live-cloud-e2e.ts` acted as both the source extractor, BullMQ producer, destination writer, and manifest logger.
- The independent, standalone background worker daemon (`packages/worker/src/worker-main.ts`, running BullMQ `Worker` consumers with concurrency 2) was **NOT active as an independent OS process consuming these jobs during this test execution**.
- The script did not wait for an external worker consumer daemon to poll or process the jobs.
- **Audit Finding:**
  - Producer-side enqueueing to Aiven Valkey is **VERIFIED**.
  - Independent worker process consumption, consumer-side job ACK/progress events, and worker-managed crash/SIGKILL recovery are **UNVERIFIED in run `MG-E2E-20261120-001`**.
  - This remains an open release gate before public production deployment.

---

## 3. Destination Ingestion & Checkpoint Ledger Summary

Even though batch writes were executed by the runner rather than an external worker process:
- **Total Batches Committed to PostgreSQL:** 15 (`migration_batches` status = `COMMITTED`)
- **Total Record Manifests Committed:** 3,391 (`record_manifests` status = `COMMITTED`)
- **High-Water Mark Checkpoint:** Stored in `migration_runs.source_boundary_json`
- **Final Run Status in PostgreSQL:** `COMPLETED`
