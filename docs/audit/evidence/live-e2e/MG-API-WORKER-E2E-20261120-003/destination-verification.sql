-- MigrationGuard — Destination Record Verification Queries
-- Run Identifier: MG-API-WORKER-E2E-20261120-003
-- Migration Run UUID: 949ab122-6e73-490b-afa6-995655357cbe

-- 1. Destination Row Counts
SELECT 'customers' as entity, COUNT(*) as count FROM customers WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe'
UNION ALL
SELECT 'orders', COUNT(*) FROM orders WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe'
UNION ALL
SELECT 'customer_attachments', COUNT(*) FROM customer_attachments WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe';

-- 2. Duplicate Check (Must return 0 rows)
SELECT id, COUNT(*) FROM customers WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM orders WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = '949ab122-6e73-490b-afa6-995655357cbe' GROUP BY id HAVING COUNT(*) > 1;

-- 3. Batch Lifecycle Progression
SELECT batch_key, sequence_no, status, records_read, records_written, records_skipped, records_failed
FROM migration_batches 
WHERE migration_run_id = '949ab122-6e73-490b-afa6-995655357cbe'
ORDER BY sequence_no ASC;

-- 4. Checkpoint State
SELECT id, status, source_boundary_json, progress_json 
FROM migration_runs 
WHERE id = '949ab122-6e73-490b-afa6-995655357cbe';
