# MigrationGuard — Live E2E Run Summary: MG-API-WORKER-E2E-20261121-004

## 1. Execution Overview

| Property | Value |
| :--- | :--- |
| **Run Identifier** | `MG-API-WORKER-E2E-20261121-004` |
| **Migration Run UUID** | `cd9bb033-5fdc-46a9-8e38-3303c2b08410` |
| **Execution Mode** | Authenticated REST API $\to$ BullMQ (migration-execution-e2e-004) $\to$ Standalone OS Worker Daemon $\to$ Dedicated Isolated PostgreSQL |
| **Host System** | `DESKTOP-TJQKT2A` (win32 x64) |
| **Initial Worker Process** | PID `20192` (Node.js `packages/worker/dist/worker-main.js`) |
| **Crash Recovery Worker** | PID `18740` (Restarted after SIGKILL) |
| **Backend API Process** | PID `15736` (Port 4001) |
| **Source Engine** | MongoDB Atlas Cloud (`migrationguard_e2e_source`) via In-Memory Vault Decryption |
| **Destination Engine** | Neon PostgreSQL Dedicated Endpoint (Schema: `migration_destination`) via In-Memory Vault Decryption |
| **Control-Plane Database** | Neon PostgreSQL (`neondb`, Schema: `public`) — 0 migration records written (Proof of Isolation) |
| **Distributed Queue** | Aiven Valkey Redis Cloud (`migration-execution-e2e-004`) |
| **Validation Engine** | MigrationGuard Deterministic Assurance Core (**8 checks executed, 8 passed, 0 failed, 0 skipped**) |

---

## 2. Authenticated REST API Trace

All actions were driven strictly through the HTTP REST API without direct database insertion:

1. **Operator Registration / Login:** `POST /api/v1/auth/register` $\to$ Bearer JWT Token generated.
2. **Project Creation:** `POST /api/v1/workspaces/ef31e03c-6598-48c2-8b6c-41bbbd1e7a31/projects` $\to$ Project ID `4c1c6d27-fffb-4cf7-9511-52181d322a36`.
3. **Source Connection:** `POST /api/v1/workspaces/ef31e03c-6598-48c2-8b6c-41bbbd1e7a31/connections` $\to$ Real MongoDB Atlas URI stored encrypted in Vault (`a8a3a169-62be-4fd4-974e-e9c705dc9d1c`).
4. **Destination Connection:** `POST /api/v1/workspaces/ef31e03c-6598-48c2-8b6c-41bbbd1e7a31/connections` $\to$ Dedicated Isolated PostgreSQL Destination URL stored encrypted in Vault (`7ebf7e42-1ee6-4069-9cc5-2af5185b7153`).
5. **Plan Creation:** `POST /api/v1/projects/4c1c6d27-fffb-4cf7-9511-52181d322a36/plans` $\to$ Plan ID `a9687aac-8553-4a0d-a032-66292caf5236`.
6. **Plan Version Creation:** `POST /api/v1/plans/a9687aac-8553-4a0d-a032-66292caf5236/versions` $\to$ Version ID `166965f3-93e3-452b-871b-412ac9f4428b`, Canonical Hash `sha256:a01dbbe5ea41110bd37b58d50e583120d44b3ad864261e1f8555d5f8cc0f5bde`.
7. **Canonical Plan Approval:** `POST /api/v1/plan-versions/166965f3-93e3-452b-871b-412ac9f4428b/approvals` $\to$ Decision `APPROVE`.
8. **Migration Run Dispatch:** `POST /api/v1/migration-runs` $\to$ Run ID `cd9bb033-5fdc-46a9-8e38-3303c2b08410`, enqueued to BullMQ queue `migration-execution-e2e-004`.

---

## 3. Worker Daemon & Destination Isolation Verification

- **BullMQ Queue Name:** `migration-execution-e2e-004` (Dedicated isolated queue, 0 interference with production queue).
- **Batches Processed:** 6 total batches across `customers`, `orders`, and `customer_attachments`.
- **Worker Concurrency:** 2 worker threads in separate OS process.
- **Payload Compliance (FR-EXEC-002):** Validated on every job: queue carried batch identifiers and cursors only, 0 bulk records in payloads.
- **Vault Credential Resolution (P0.1 & P0.3):** Worker resolved destination credentials dynamically from PostgreSQL `connection_secrets` vault pinned to `credential_version`, created a dedicated connection pool, and routed all writes to `migration_destination`.
- **Destination Isolation Result:**
  - Dedicated Destination (`migration_destination`): 600 records written (200 customers, 200 orders, 200 attachments).
  - Control-Plane DB (`public`): Exactly 0 records written for run `cd9bb033-5fdc-46a9-8e38-3303c2b08410`.
  - **Empirical Confirmation:** The worker did NOT write to `DATABASE_URL` or use `defaultDestinationConnector`.

---

## 4. Crash Recovery (SIGKILL & Restart)

- **Active In-Flight Pre-Condition:** At least 1 committed batch AND at least 1 distinct active BullMQ job in flight at termination.
- **Target In-Flight Job:** Job ID `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0001` (Batch: `batch_orders_0001`).
- **Crash Injection:** `process.kill(20192, 'SIGKILL')` was triggered abruptly during active execution.
- **Interruption Verification:** Worker process terminated abruptly. Connection pool closed.
- **Pre-Kill DB Checkpoint:** {"customers":{"updatedAt":"2026-11-20T22:06:53.429Z","sourceObject":"customers","planVersionId":"166965f3-93e3-452b-871b-412ac9f4428b","baseSequenceNo":1,"migrationRunId":"cd9bb033-5fdc-46a9-8e38-3303c2b08410","committedEntries":{"1":{"batchKey":"batch_customers_0001","cursorEnd":{"lastId":"cust_000100"}}},"mappingVersionId":"default-mapping","committedSequences":[1],"lastCommittedCursor":{"lastId":"cust_000100"},"lastCommittedBatchKey":"batch_customers_0001","totalRecordsCommitted":100,"lastCommittedSequenceNo":1}}.
- **Restart Execution:** Worker daemon respawned with PID `18740`.
- **Atomic Checkpoint Updates (P0.4):** Checkpoints updated with PostgreSQL row-level locks (`SELECT ... FOR UPDATE`), preventing race conditions.
- **Integrity Result:** All 6 batches committed (0 failed); 0 duplicate rows written, 0 skipped rows.

---

## 5. Destination Verification & Validation Engine

| Destination Entity | Target Rows Written (Destination Schema) | Rows in Control Plane Schema | Duplicate Count | Integrity Status |
| :--- | :---: | :---: | :---: | :---: |
| `customers` | 200 | 0 | 0 | **VERIFIED & ISOLATED** |
| `orders` | 200 | 0 | 0 | **VERIFIED & ISOLATED** |
| `customer_attachments` | 200 | 0 | 0 | **VERIFIED & ISOLATED** |

### Validation Engine Evaluation (8 Checks):
- **Total Checks:** 8
- **Passed Checks:** 8
- **Failed Checks:** 0
- **Skipped Checks:** 0
- **Attachment Check:** Attachment checksum metadata matched for 200 records (physical binary S3 transfer deferred to post-MVP).
- **Result:** **PASS (100% Assurance)**
