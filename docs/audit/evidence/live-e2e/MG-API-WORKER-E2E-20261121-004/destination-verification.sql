-- MigrationGuard — Destination Record Verification Queries
-- Run Identifier: MG-API-WORKER-E2E-20261121-004
-- Migration Run UUID: cd9bb033-5fdc-46a9-8e38-3303c2b08410

-- 1. Dedicated Destination Row Counts (Schema: migration_destination)
SELECT 'customers' as entity, COUNT(*) as count FROM migration_destination.customers WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410'
UNION ALL
SELECT 'orders', COUNT(*) FROM migration_destination.orders WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410'
UNION ALL
SELECT 'customer_attachments', COUNT(*) FROM migration_destination.customer_attachments WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410';

-- 2. Control-Plane Isolation Check (Public Schema — MUST BE 0)
SELECT 'public.customers' as entity, COUNT(*) as count FROM public.customers WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410'
UNION ALL
SELECT 'public.orders', COUNT(*) FROM public.orders WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410'
UNION ALL
SELECT 'public.customer_attachments', COUNT(*) FROM public.customer_attachments WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410';

-- 3. Duplicate Check on Destination (Must return 0 rows)
SELECT id, COUNT(*) FROM migration_destination.customers WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM migration_destination.orders WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;
SELECT id, COUNT(*) FROM migration_destination.customer_attachments WHERE run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410' GROUP BY id HAVING COUNT(*) > 1;

-- 4. Batch Lifecycle Progression
SELECT batch_key, sequence_no, status, records_read, records_written, records_skipped, records_failed
FROM migration_batches 
WHERE migration_run_id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410'
ORDER BY sequence_no ASC;

-- 5. Checkpoint State
SELECT id, status, source_boundary_json, progress_json 
FROM migration_runs 
WHERE id = 'cd9bb033-5fdc-46a9-8e38-3303c2b08410';
