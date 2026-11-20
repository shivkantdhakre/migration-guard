-- MigrationGuard — Destination Record Verification Queries
-- Run Identifier: MG-API-WORKER-E2E-20261120-002
-- Migration Run UUID: c4816ce2-caef-4a4d-ac86-e922b1e8807d

-- 1. Destination Row Counts
SELECT 'customers' as entity, COUNT(*) as count FROM customers WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d'
UNION ALL
SELECT 'orders', COUNT(*) FROM orders WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d'
UNION ALL
SELECT 'customer_attachments', COUNT(*) FROM customer_attachments WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d';

-- 2. Duplicate Check (Must return 0 rows)
SELECT id, COUNT(*) FROM customers WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM orders WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d' GROUP BY id HAVING COUNT(*) > 1;

-- 3. Batch Lifecycle Progression
SELECT batch_key, sequence_no, status, records_read, records_written, records_skipped, records_failed
FROM migration_batches 
WHERE migration_run_id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d'
ORDER BY sequence_no ASC;

-- 4. Checkpoint State
SELECT id, status, source_boundary_json, progress_json 
FROM migration_runs 
WHERE id = 'c4816ce2-caef-4a4d-ac86-e922b1e8807d';
