# MigrationGuard — Live E2E Run Summary: MG-API-WORKER-E2E-20261120-002

## 1. Execution Overview

| Property | Value |
| :--- | :--- |
| **Run Identifier** | `MG-API-WORKER-E2E-20261120-002` |
| **Migration Run UUID** | `c4816ce2-caef-4a4d-ac86-e922b1e8807d` |
| **Execution Mode** | Authenticated REST API $\to$ BullMQ $\to$ Standalone OS Worker Daemon $\to$ Neon PostgreSQL |
| **Host System** | `DESKTOP-TJQKT2A` (win32 x64) |
| **Initial Worker Process** | PID `14184` (Node.js `packages/worker/dist/worker-main.js`) |
| **Crash Recovery Worker** | PID `4648` (Restarted after SIGKILL) |
| **Backend API Process** | PID `8572` (Port 4000) |
| **Source Engine** | MongoDB Atlas Cloud (`migrationguard_e2e_source`) |
| **Destination Engine** | Neon PostgreSQL (`neondb`, Schema: `public`) |
| **Distributed Queue** | Aiven Valkey Redis Cloud (`migration-execution`) |
| **Validation Engine** | MigrationGuard Deterministic Assurance Core (**8 checks executed, 8 passed, 0 failed**) |

---

## 2. Authenticated REST API Trace

All actions were driven strictly through the HTTP REST API without direct database insertion:

1. **Operator Registration / Login:** `POST /api/v1/auth/register` $\to$ Bearer JWT Token generated.
2. **Project Creation:** `POST /api/v1/workspaces/37397af3-8929-4265-9a16-e68e70e7c6d9/projects` $\to$ Project ID `daed39a7-7c8e-470a-87f4-76240bcf7b56`.
3. **Source Connection:** `POST /api/v1/workspaces/37397af3-8929-4265-9a16-e68e70e7c6d9/connections` $\to$ MongoDB Atlas Registered (`e19d570c-d4ab-4e1d-9f74-54903cbdcc20`).
4. **Destination Connection:** `POST /api/v1/workspaces/37397af3-8929-4265-9a16-e68e70e7c6d9/connections` $\to$ Neon PostgreSQL Registered (`662316e4-26e5-4adf-a161-7cef9402ead5`).
5. **Plan Creation:** `POST /api/v1/projects/daed39a7-7c8e-470a-87f4-76240bcf7b56/plans` $\to$ Plan ID `fa5761c9-c255-4d27-910a-75866779b9e3`.
6. **Plan Version Creation:** `POST /api/v1/plans/fa5761c9-c255-4d27-910a-75866779b9e3/versions` $\to$ Version ID `42a3288d-acfb-4218-af5e-1ba3006a10e3`, Canonical Hash `sha256:e7ba5be8e6ea77ec2cad5f24f3d2962a2c05840ad378ee794f0e89d1d35b2c91`.
7. **Canonical Plan Approval:** `POST /api/v1/plan-versions/42a3288d-acfb-4218-af5e-1ba3006a10e3/approvals` $\to$ Decision `APPROVE`.
8. **Migration Run Dispatch:** `POST /api/v1/migration-runs` $\to$ Run ID `c4816ce2-caef-4a4d-ac86-e922b1e8807d`, enqueued to BullMQ.

---

## 3. Worker Daemon & Queue Lifecycle

- **BullMQ Queue Name:** `migration-execution`
- **Batches Processed:** 6 total batches across `customers`, `orders`, and `customer_attachments`.
- **Worker Concurrency:** 2 worker threads in separate OS process.
- **Payload Compliance (FR-EXEC-002):** Validated on every job: queue carried batch identifiers and cursors only, 0 bulk records in payloads.

---

## 4. Crash Recovery (SIGKILL & Restart)

- **Crash Injection:** `process.kill(14184, 'SIGKILL')` was triggered after committed processing.
- **Interruption Verification:** Worker process terminated abruptly. PostgreSQL connection closed.
- **Restart Execution:** Worker daemon respawned with PID `4648`.
- **Resumption Semantics:** Resumed processing remaining queue items from last committed checkpoint.
- **Integrity Result:** 0 duplicate rows written, 0 skipped rows.

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
- **Result:** **PASS (100% Assurance)**
