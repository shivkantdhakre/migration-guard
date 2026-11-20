# MigrationGuard — Process-Level Crash Recovery Evidence: MG-API-WORKER-E2E-20261120-002

## 1. Objective

Demonstrate OS-level worker termination during active migration processing, followed by worker daemon restart and resumption from the last committed PostgreSQL checkpoint without duplicate writes or data loss.

## 2. Interruption Event

- **Initial Worker PID:** `14184`
- **Signal Sent:** `SIGKILL` (Hard uncatchable process kill)
- **Batches Committed Pre-Kill:** 1+ batches durably committed in PostgreSQL.
- **Database Boundary State at Kill:** `source_boundary_json` preserved in `migration_runs`.

## 3. Resumption Event

- **Restarted Worker PID:** `4648`
- **Queue State at Restart:** BullMQ re-assigned remaining jobs to the new worker process.
- **Checkpoint Resumption:** The new worker read the committed cursors from PostgreSQL and continued batch streaming.
- **Final Result:** All 6 batches transitioned to `COMMITTED`.

## 4. Duplicate Check SQL Verification

```sql
SELECT id, COUNT(*) FROM customers WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM orders WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows

SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;
-- Result: 0 rows
```
