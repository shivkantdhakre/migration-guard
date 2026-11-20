# MigrationGuard — Run Summary: MG-E2E-20261120-001
**Execution Status:** **LIVE CLOUD RELATIONAL MIGRATION & ASSURANCE COMPLETE**  
**Timestamp:** 2026-11-19T22:47:39.843Z  
**Run Correlation ID:** `MG-E2E-20261120-001`  
**PostgreSQL Migration Run UUID:** `36988c91-405c-41fe-9919-e01377cf0033`  
**Source Database:** MongoDB Atlas (`migrationguard_e2e_source`)  
**Destination Database:** Neon Cloud PostgreSQL (`neondb`)  
**Distributed Queue:** Aiven Valkey Redis (`rediss://valkey-137cc70c-*.aivencloud.com:15678`)  

---

## 1. Verified Record Counts

- **Customers:** `1,000` / `1,000` (100% Match)
- **Orders:** `2,028` / `2,028` (100% Match)
- **Customer Attachments (Metadata):** `363` / `363` (100% Match)
- **Physical S3 Binary Files:** `0` (MVP documented limitation; metadata-only cataloged)
- **Orphaned Orders (FK Violations):** `0`
- **Orphaned Customer Attachments (FK Violations):** `0`

---

## 2. Queue & Batch Coordination

- **BullMQ Queue Name:** `migration-execution` on Aiven Cloud Valkey
- **Total Dispatched BullMQ Jobs:** `15` jobs (producer dispatch verified)
- **Total Committed Migration Batches:** `15` batches (recorded in `migration_batches`)
- **Execution Mode:** Batches extracted and written synchronously by test runner; independent background worker consumer consumption remains unverified.

---

## 3. Deterministic Validation Engine Summary

- **Overall State:** `PASS`
- **Validation Engine Execution Time:** `183ms` (Total relational migration duration: `7.42s`)
- **Check Accounting:** **8 checks executed, 8 passed, 0 failed, 0 skipped**
- **Total Discrepancies:** `0`
- **Scope Note:** Full canonical content hashes were verified for customers. Orders and attachment metadata were verified for relational integrity and checksums. No physical S3 binary payloads were verified.
