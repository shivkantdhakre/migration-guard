-- MigrationGuard — Destination Record Verification Queries
-- Run Identifier: MG-API-WORKER-E2E-20261121-005
-- Migration Run UUID: 0ebd821e-2571-4b76-84a4-20e8bd4315c1
-- Dedicated Destination Database: migrationguard_destination_005

-- 1. Dedicated Destination Row Counts (Database: migrationguard_destination_005, Schema: public)
SELECT 'customers' as entity, COUNT(*) as count FROM customers WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1'
UNION ALL
SELECT 'orders', COUNT(*) FROM orders WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1'
UNION ALL
SELECT 'customer_attachments', COUNT(*) FROM customer_attachments WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1';

-- 2. Control-Plane Isolation Check (Database: neondb, Schema: public — MUST BE 0)
SELECT 'public.customers' as entity, COUNT(*) as count FROM public.customers WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1'
UNION ALL
SELECT 'public.orders', COUNT(*) FROM public.orders WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1'
UNION ALL
SELECT 'public.customer_attachments', COUNT(*) FROM public.customer_attachments WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1';

-- 3. Duplicate Check on Destination (Must return 0 rows)
SELECT id, COUNT(*) FROM customers WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM orders WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM customer_attachments WHERE run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1' GROUP BY id HAVING COUNT(*) > 1;

-- 4. Batch Lifecycle Progression
SELECT batch_key, sequence_no, status, records_read, records_written, records_skipped, records_failed
FROM migration_batches 
WHERE migration_run_id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1'
ORDER BY sequence_no ASC;

-- 5. Checkpoint State
SELECT id, status, source_boundary_json, progress_json 
FROM migration_runs 
WHERE id = '0ebd821e-2571-4b76-84a4-20e8bd4315c1';
