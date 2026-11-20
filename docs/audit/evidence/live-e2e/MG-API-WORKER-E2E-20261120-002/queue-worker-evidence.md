# MigrationGuard — Queue & Worker Daemon Evidence: MG-API-WORKER-E2E-20261120-002

## 1. Process Architecture

```
+-----------------------+        HTTP REST         +-----------------------+
|  Test Orchestrator    | -----------------------> |  NestJS API Backend   |
|  (HTTP Client)        |                          |  (PID: 8572)         |
+-----------------------+                          +-----------------------+
                                                               |
                                                          BullMQ Job
                                                           Dispatch
                                                               v
                                                   +-----------------------+
                                                   |   Aiven Valkey Redis  |
                                                   | 'migration-execution' |
                                                   +-----------------------+
                                                               |
                                                          BullMQ Job
                                                          Consumption
                                                               v
                                                   +-----------------------+
+-----------------------+                          |  Standalone Worker    |
|   Neon PostgreSQL     | <----------------------- |  Daemon Process       |
|   Destination DB      |   Idempotent SQL Batch   |  PID: 14184 -> 4648  |
+-----------------------+                          +-----------------------+
```

## 2. BullMQ Job Lifecycle

- **Queue Target:** `valkey-137cc70c-veraastras-475e.j.aivencloud.com:15678` (TLS enabled)
- **Job States Observed:** `waiting` $\to$ `active` $\to$ `completed`
- **Job IDs Dispatched:**
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0001` (Sequence: 1, Status: `FAILED_PERMANENT`)
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0002` (Sequence: 2, Status: `COMMITTED`)
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_orders_0001` (Sequence: 3, Status: `COMMITTED`)
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_orders_0002` (Sequence: 4, Status: `COMMITTED`)
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customer_attachments_0001` (Sequence: 5, Status: `COMMITTED`)
  - `c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customer_attachments_0002` (Sequence: 6, Status: `COMMITTED`)

## 3. Worker Daemon Log Extracts

```
========================================================================
   MigrationGuard Data-Plane Migration Worker
   Specification: 04_SYSTEM_ARCHITECTURE.md (Section 5: Worker Pools)
========================================================================
[Worker] Process ID: 14184
[Worker] Redis target: Cloud Valkey/Redis
[Worker] Database target: postgresql://neondb_owner:***@ep-billowing-block-ao9lt8tz-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
[Worker] Source target: MongoDB (migrationguard_e2e_source)
[Worker] Worker pools initialized:
  ✔ migration-execution  (Concurrency: 2)
  ✔ PostgreSQL destination ready
  ✔ Manifest & Checkpoint tracking active
[Worker] Worker is listening for jobs.
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0001)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_customers_0001, Object: customers -> customers
[STDERR] (node:14184) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
[STDERR] In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
[STDERR] To prepare for this change:
[STDERR] - If you want the current behavior, explicitly use 'sslmode=verify-full'
[STDERR] - If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
[STDERR] See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
[STDERR] (Use `node --trace-warnings ...` to show where the warning was created)
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0002)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_customers_0002, Object: customers -> customers
[Worker] ✔ Batch batch_customers_0002 executed: Read 100, Written 100, Status: COMMITTED
[Worker] ✔ Batch batch_customers_0001 executed: Read 100, Written 100, Status: FAILED_PERMANENT
[Worker] Job c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0002 marked COMPLETED.
[Worker] Job c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customers_0001 marked COMPLETED.
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_orders_0001)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_orders_0001, Object: orders -> orders
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_orders_0002)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_orders_0002, Object: orders -> orders
========================================================================
   MigrationGuard Data-Plane Migration Worker
   Specification: 04_SYSTEM_ARCHITECTURE.md (Section 5: Worker Pools)
========================================================================
[Worker] Process ID: 4648
[Worker] Redis target: Cloud Valkey/Redis
[Worker] Database target: postgresql://neondb_owner:***@ep-billowing-block-ao9lt8tz-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
[Worker] Source target: MongoDB (migrationguard_e2e_source)
[Worker] Worker pools initialized:
  ✔ migration-execution  (Concurrency: 2)
  ✔ PostgreSQL destination ready
  ✔ Manifest & Checkpoint tracking active
[Worker] Worker is listening for jobs.
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customer_attachments_0001)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_customer_attachments_0001, Object: customer_attachments -> customer_attachments
[Worker] Received job: process-batch (Job ID: c4816ce2-caef-4a4d-ac86-e922b1e8807d_batch_customer_attachments_0002)
[Worker] Executing run: c4816ce2-caef-4a4d-ac86-e922b1e8807d, Batch: batch_customer_attachments_0002, Object: customer_attachments -> customer_attachments
[STDERR] (node:4648) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
```
