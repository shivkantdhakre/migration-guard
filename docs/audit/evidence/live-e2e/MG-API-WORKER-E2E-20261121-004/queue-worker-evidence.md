# MigrationGuard — Queue & Worker Daemon Evidence: MG-API-WORKER-E2E-20261121-004

## 1. Process Architecture

```
+-----------------------+        HTTP REST         +-----------------------+
|  Test Orchestrator    | -----------------------> |  NestJS API Backend   |
|  (HTTP Client)        |                          |  (PID: 15736)         |
+-----------------------+                          +-----------------------+
                                                               |
                                                          BullMQ Job
                                                           Dispatch
                                                               v
                                                   +-----------------------+
                                                   |   Aiven Valkey Redis  |
                                                   | 'migration-execution-e2e-004' |
                                                   +-----------------------+
                                                               |
                                                          BullMQ Job
                                                          Consumption
                                                               v
                                                   +-----------------------+
+-----------------------+                          |  Standalone Worker    |
|   Neon PostgreSQL     | <----------------------- |  Daemon Process       |
|   Destination DB      |   Idempotent SQL Batch   |  PID: 20192 -> 18740  |
|  (Isolated Schema)    |                          |  (Vault Decryption)   |
+-----------------------+                          +-----------------------+
```

## 2. BullMQ Job Lifecycle

- **Queue Target:** `valkey-137cc70c-veraastras-475e.j.aivencloud.com:15678` (TLS enabled, Queue: `migration-execution-e2e-004`)
- **Job States Observed:** `waiting` $\to$ `active` $\to$ `completed`
- **Job IDs Dispatched & Completed:**
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0001` (Sequence: 1, Status: `COMMITTED`)
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0002` (Sequence: 2, Status: `COMMITTED`)
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0001` (Sequence: 3, Status: `COMMITTED`)
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0002` (Sequence: 4, Status: `COMMITTED`)
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customer_attachments_0001` (Sequence: 5, Status: `COMMITTED`)
  - `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customer_attachments_0002` (Sequence: 6, Status: `COMMITTED`)

## 3. Worker Daemon Log Extracts

```
========================================================================
   MigrationGuard Data-Plane Migration Worker
   Specification: 04_SYSTEM_ARCHITECTURE.md (Section 5: Worker Pools)
========================================================================
[Worker] Process ID: 20192
[Worker] Redis target: Cloud Valkey/Redis
[Worker] Database target: postgresql://neondb_owner:***@ep-billowing-block-ao9lt8tz-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
[Worker] Source target: Vault-driven resolution active (ENV fallback disabled)
[Worker] Worker pools initialized:
  ✔ BullMQ Queue: 'migration-execution-e2e-004' (Concurrency: 2)
  ✔ PostgreSQL destination ready
  ✔ Manifest & Checkpoint tracking active
  ✔ Encrypted Vault credential resolution active
[Worker] Worker is listening for jobs.
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0001) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_customers_0001, Object: customers -> customers
[STDERR] (node:20192) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
[STDERR] In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
[STDERR] To prepare for this change:
[STDERR] - If you want the current behavior, explicitly use 'sslmode=verify-full'
[STDERR] - If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
[STDERR] See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
[STDERR] (Use `node --trace-warnings ...` to show where the warning was created)
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0002) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_customers_0002, Object: customers -> customers
[Worker] ✔ Dynamically resolved MongoDB source connector from Vault for connection a8a3a169-62be-4fd4-974e-e9c705dc9d1c (database: migrationguard_e2e_source)
[Worker] ✔ Dynamically resolved MongoDB source connector from Vault for connection a8a3a169-62be-4fd4-974e-e9c705dc9d1c (database: migrationguard_e2e_source)
[Worker] ✔ Creating dedicated PostgreSQL destination pool for connection 7ebf7e42-1ee6-4069-9cc5-2af5185b7153 v1
[Worker] ✔ Reusing cached destination pool for connection 7ebf7e42-1ee6-4069-9cc5-2af5185b7153 v1
[Worker] ✔ Batch batch_customers_0002 executed: Read 100, Written 100, Status: COMMITTED
[Worker] Job cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0002 marked COMPLETED.
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0001) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_orders_0001, Object: orders -> orders
[Worker] ✔ Batch batch_customers_0001 executed: Read 100, Written 100, Status: COMMITTED
[Worker] ✔ Reusing cached destination pool for connection 7ebf7e42-1ee6-4069-9cc5-2af5185b7153 v1
[Worker] Job cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customers_0001 marked COMPLETED.
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0002) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_orders_0002, Object: orders -> orders
[Worker] ✔ Reusing cached destination pool for connection 7ebf7e42-1ee6-4069-9cc5-2af5185b7153 v1
========================================================================
   MigrationGuard Data-Plane Migration Worker
   Specification: 04_SYSTEM_ARCHITECTURE.md (Section 5: Worker Pools)
========================================================================
[Worker] Process ID: 18740
[Worker] Redis target: Cloud Valkey/Redis
[Worker] Database target: postgresql://neondb_owner:***@ep-billowing-block-ao9lt8tz-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
[Worker] Source target: Vault-driven resolution active (ENV fallback disabled)
[Worker] Worker pools initialized:
  ✔ BullMQ Queue: 'migration-execution-e2e-004' (Concurrency: 2)
  ✔ PostgreSQL destination ready
  ✔ Manifest & Checkpoint tracking active
  ✔ Encrypted Vault credential resolution active
[Worker] Worker is listening for jobs.
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customer_attachments_0001) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_customer_attachments_0001, Object: customer_attachments -> customer_attachments
[Worker] Received job: process-batch (Job ID: cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_customer_attachments_0002) on queue 'migration-execution-e2e-004'
[Worker] Executing run: cd9bb033-5fdc-46a9-8e38-3303c2b08410, Batch: batch_customer_attachments_0002, Object: customer_attachments -> customer_attachments
[STDERR] (node:18740) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
[STDERR] In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
[STDERR] To prepare for this change:
```
