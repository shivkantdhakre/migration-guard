# MigrationGuard — Process-Level Crash Recovery Evidence: MG-API-WORKER-E2E-20261121-005

## 1. Objective

Demonstrate OS-level worker termination during active in-flight batch execution, followed by worker daemon restart and resumption from the last committed PostgreSQL checkpoint without duplicate writes or data loss.

## 2. In-Flight Termination Event

- **Target Active Job ID:** `0ebd821e-2571-4b76-84a4-20e8bd4315c1_batch_orders_0001`
- **Target Active Batch Key:** `batch_orders_0001`
- **Initial Worker PID:** `18740`
- **Signal Sent:** `SIGKILL` (Hard uncatchable process kill)
- **Batches Committed Pre-Kill:** 2
- **Pre-Kill Batch Manifest Written Total:** 200 records
- **Pre-Kill Database Checkpoint Total:** 200 records
- **Pre-Kill Reconciliation Assertion:** PASSED (200 === 200)
- **Database Boundary State at Kill:** `{"customers":{"updatedAt":"2026-11-20T23:23:47.909Z","sourceObject":"customers","planVersionId":"1c6a92e3-6c79-4e42-b19f-2ac50a16211f","baseSequenceNo":2,"migrationRunId":"0ebd821e-2571-4b76-84a4-20e8bd4315c1","committedEntries":{"1":{"batchKey":"batch_customers_0001","cursorEnd":{"lastId":"cust_000100"}},"2":{"batchKey":"batch_customers_0002","cursorEnd":{"lastId":"cust_000200"}}},"mappingVersionId":"default-mapping","committedSequences":[1,2],"lastCommittedCursor":{"lastId":"cust_000200"},"lastCommittedBatchKey":"batch_customers_0002","totalRecordsCommitted":200,"lastCommittedSequenceNo":2}}`

## 3. Resumption Event

- **Restarted Worker PID:** `22652`
- **Queue State at Restart:** BullMQ re-delivered the active in-flight batch to the new worker process.
- **Checkpoint Resumption:** The new worker read the committed cursors from PostgreSQL using atomic row-level locks and continued batch streaming without sequence regression.
- **Final Result:** All 6 batches transitioned to `COMMITTED` (0 failed).

## 4. Duplicate Check SQL Verification

```sql
SELECT id, COUNT(*) FROM customers WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM orders WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows
```
