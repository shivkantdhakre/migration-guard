# MigrationGuard — Process-Level Crash Recovery Evidence: MG-API-WORKER-E2E-20261120-003

## 1. Objective

Demonstrate OS-level worker termination during active in-flight batch execution, followed by worker daemon restart and resumption from the last committed PostgreSQL checkpoint without duplicate writes or data loss.

## 2. In-Flight Termination Event

- **Target Active Job ID:** `949ab122-6e73-490b-afa6-995655357cbe_batch_orders_0001`
- **Target Active Batch Key:** `batch_orders_0001`
- **Initial Worker PID:** `19548`
- **Signal Sent:** `SIGKILL` (Hard uncatchable process kill)
- **Batches Committed Pre-Kill:** 2
- **Records Written Pre-Kill:** 200
- **Database Boundary State at Kill:** `{"customers":{"updatedAt":"2026-11-20T20:12:02.640Z","sourceObject":"customers","planVersionId":"521eeb77-b689-4a23-9f05-cefeb4f8c23b","baseSequenceNo":2,"migrationRunId":"949ab122-6e73-490b-afa6-995655357cbe","committedEntries":{"1":{"batchKey":"batch_customers_0001","cursorEnd":{"lastId":"cust_000100"}},"2":{"batchKey":"batch_customers_0002","cursorEnd":{"lastId":"cust_000200"}}},"mappingVersionId":"default-mapping","committedSequences":[1,2],"lastCommittedCursor":{"lastId":"cust_000200"},"lastCommittedBatchKey":"batch_customers_0002","totalRecordsCommitted":200,"lastCommittedSequenceNo":2}}`

## 3. Resumption Event

- **Restarted Worker PID:** `19260`
- **Queue State at Restart:** BullMQ re-delivered the active in-flight batch to the new worker process.
- **Checkpoint Resumption:** The new worker read the committed cursors from PostgreSQL and continued batch streaming without sequence regression.
- **Final Result:** All 6 batches transitioned to `COMMITTED` (0 failed).

## 4. Duplicate Check SQL Verification

```sql
SELECT id, COUNT(*) FROM customers WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM orders WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows
```
