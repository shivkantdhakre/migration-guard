# MigrationGuard — Live E2E Run Summary: MG-API-WORKER-E2E-20261120-003

## 1. Execution Overview

| Property | Value |
| :--- | :--- |
| **Run Identifier** | `MG-API-WORKER-E2E-20261120-003` |
| **Migration Run UUID** | `949ab122-6e73-490b-afa6-995655357cbe` |
| **Execution Mode** | Authenticated REST API $\to$ BullMQ (migration-execution-e2e) $\to$ Standalone OS Worker Daemon $\to$ Neon PostgreSQL |
| **Host System** | `DESKTOP-TJQKT2A` (win32 x64) |
| **Initial Worker Process** | PID `19548` (Node.js `packages/worker/dist/worker-main.js`) |
| **Crash Recovery Worker** | PID `19260` (Restarted after SIGKILL) |
| **Backend API Process** | PID `26572` (Port 4000) |
| **Source Engine** | MongoDB Atlas Cloud (`migrationguard_e2e_source`) via In-Memory Vault Decryption |
| **Destination Engine** | Neon PostgreSQL (`neondb`, Schema: `public`) via In-Memory Vault Decryption |
| **Distributed Queue** | Aiven Valkey Redis Cloud (`migration-execution-e2e`) |
| **Validation Engine** | MigrationGuard Deterministic Assurance Core (**8 checks executed, 8 passed, 0 failed, 0 skipped**) |

---

## 2. Authenticated REST API Trace

All actions were driven strictly through the HTTP REST API without direct database insertion:

1. **Operator Registration / Login:** `POST /api/v1/auth/register` $\to$ Bearer JWT Token generated.
2. **Project Creation:** `POST /api/v1/workspaces/a6bbb903-145a-4d96-af23-1e02ef366ac0/projects` $\to$ Project ID `e1b40f2f-1a8e-4f73-8863-c436ad73b397`.
3. **Source Connection:** `POST /api/v1/workspaces/a6bbb903-145a-4d96-af23-1e02ef366ac0/connections` $\to$ Real MongoDB Atlas URI stored encrypted in Vault (`b9261724-a48f-434e-926d-6a6ac39d83ad`).
4. **Destination Connection:** `POST /api/v1/workspaces/a6bbb903-145a-4d96-af23-1e02ef366ac0/connections` $\to$ Real Neon PostgreSQL URL stored encrypted in Vault (`d76af89a-4ffa-46d3-bc3a-23d2c1b8f1f5`).
5. **Plan Creation:** `POST /api/v1/projects/e1b40f2f-1a8e-4f73-8863-c436ad73b397/plans` $\to$ Plan ID `aa38729a-3d4e-46ea-88c9-5c3e197b884a`.
6. **Plan Version Creation:** `POST /api/v1/plans/aa38729a-3d4e-46ea-88c9-5c3e197b884a/versions` $\to$ Version ID `521eeb77-b689-4a23-9f05-cefeb4f8c23b`, Canonical Hash `sha256:97a33bd2ad0e3b28c1228342c18b862b6c1d95597250586b8d8eddfe47671fef`.
7. **Canonical Plan Approval:** `POST /api/v1/plan-versions/521eeb77-b689-4a23-9f05-cefeb4f8c23b/approvals` $\to$ Decision `APPROVE`.
8. **Migration Run Dispatch:** `POST /api/v1/migration-runs` $\to$ Run ID `949ab122-6e73-490b-afa6-995655357cbe`, enqueued to BullMQ queue `migration-execution-e2e`.

---

## 3. Worker Daemon & Queue Lifecycle

- **BullMQ Queue Name:** `migration-execution-e2e` (Dedicated isolated queue, 0 interference with production queue)
- **Batches Processed:** 6 total batches across `customers`, `orders`, and `customer_attachments`.
- **Worker Concurrency:** 2 worker threads in separate OS process.
- **Payload Compliance (FR-EXEC-002):** Validated on every job: queue carried batch identifiers and cursors only, 0 bulk records in payloads.
- **Vault Credential Resolution:** Worker daemon ran with `MONGO_URL` stripped from process environment; verified in-memory decryption from database `connection_secrets` vault.
- **BullMQ Acknowledgement Semantics:** Worker processor strictly configured to reject/throw if batch status is not `COMMITTED`, preventing uncommitted batches from reporting successful completion.

---

## 4. Crash Recovery (SIGKILL & Restart)

- **Active In-Flight Pre-Condition:** At least 1 committed batch AND at least 1 distinct active BullMQ job in flight at termination.
- **Target In-Flight Job:** Job ID `949ab122-6e73-490b-afa6-995655357cbe_batch_orders_0001` (Batch: `batch_orders_0001`).
- **Crash Injection:** `process.kill(19548, 'SIGKILL')` was triggered abruptly during active execution.
- **Interruption Verification:** Worker process terminated abruptly. PostgreSQL connection closed.
- **Pre-Kill DB Checkpoint:** {"customers":{"updatedAt":"2026-11-20T20:12:02.640Z","sourceObject":"customers","planVersionId":"521eeb77-b689-4a23-9f05-cefeb4f8c23b","baseSequenceNo":2,"migrationRunId":"949ab122-6e73-490b-afa6-995655357cbe","committedEntries":{"1":{"batchKey":"batch_customers_0001","cursorEnd":{"lastId":"cust_000100"}},"2":{"batchKey":"batch_customers_0002","cursorEnd":{"lastId":"cust_000200"}}},"mappingVersionId":"default-mapping","committedSequences":[1,2],"lastCommittedCursor":{"lastId":"cust_000200"},"lastCommittedBatchKey":"batch_customers_0002","totalRecordsCommitted":200,"lastCommittedSequenceNo":2}}.
- **Restart Execution:** Worker daemon respawned with PID `19260`.
- **Resumption Semantics:** Resumed processing remaining queue items from last committed checkpoint without sequence regression.
- **Integrity Result:** All 6 batches committed (0 failed); 0 duplicate rows written, 0 skipped rows.

---

## 5. Destination Verification & Validation Engine

| Destination Entity | Target Rows Written | Duplicate Count | Integrity Status |
| :--- | :---: | :---: | :---: |
| `customers` | 200 | 0 | **VERIFIED** |
| `orders` | 200 | 0 | **VERIFIED** |
| `customer_attachments` | 200 | 0 | **VERIFIED** |

### Validation Engine Evaluation (8 Checks):
- **Total Checks:** 8
- **Passed Checks:** 8
- **Failed Checks:** 0
- **Skipped Checks:** 0
- **Attachment Check:** Attachment checksum metadata matched for 200 records (physical binary S3 transfer deferred to post-MVP).
- **Result:** **PASS (100% Assurance)**
