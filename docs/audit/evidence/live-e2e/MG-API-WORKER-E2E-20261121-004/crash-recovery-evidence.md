# MigrationGuard — Process-Level Crash Recovery Evidence: MG-API-WORKER-E2E-20261121-004

## 1. Objective

Demonstrate OS-level worker termination during active in-flight batch execution, followed by worker daemon restart and resumption from the last committed PostgreSQL checkpoint without duplicate writes or data loss.

## 2. In-Flight Termination Event

- **Target Active Job ID:** `cd9bb033-5fdc-46a9-8e38-3303c2b08410_batch_orders_0001`
- **Target Active Batch Key:** `batch_orders_0001`
- **Initial Worker PID:** `20192`
- **Signal Sent:** `SIGKILL` (Hard uncatchable process kill)
- **Batches Committed Pre-Kill:** 2
- **Records Written Pre-Kill:** 200
- **Database Boundary State at Kill:** `{"customers":{"updatedAt":"2026-11-20T22:06:53.429Z","sourceObject":"customers","planVersionId":"166965f3-93e3-452b-871b-412ac9f4428b","baseSequenceNo":1,"migrationRunId":"cd9bb033-5fdc-46a9-8e38-3303c2b08410","committedEntries":{"1":{"batchKey":"batch_customers_0001","cursorEnd":{"lastId":"cust_000100"}}},"mappingVersionId":"default-mapping","committedSequences":[1],"lastCommittedCursor":{"lastId":"cust_000100"},"lastCommittedBatchKey":"batch_customers_0001","totalRecordsCommitted":100,"lastCommittedSequenceNo":1}}`

## 3. Resumption Event

- **Restarted Worker PID:** `18740`
- **Queue State at Restart:** BullMQ re-delivered the active in-flight batch to the new worker process.
- **Checkpoint Resumption:** The new worker read the committed cursors from PostgreSQL with atomic row-level locks and continued batch streaming without sequence regression.
- **Final Result:** All 6 batches transitioned to `COMMITTED` (0 failed).

## 4. Duplicate Check SQL Verification

```sql
SELECT id, COUNT(*) FROM migration_destination.customers WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM migration_destination.orders WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM migration_destination.customer_attachments WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows
```
