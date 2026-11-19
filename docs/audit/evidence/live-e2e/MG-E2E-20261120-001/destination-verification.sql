-- MigrationGuard — Live Cloud Destination Verification Queries
-- Run ID: MG-E2E-20261120-001
-- Scope: Read-only independent destination verification

-- 1. Baseline Row Counts
SELECT COUNT(*) AS total_customers FROM customers;
SELECT COUNT(*) AS total_orders FROM orders;
SELECT COUNT(*) AS total_attachments FROM customer_attachments;

-- 2. Foreign Key & Relational Integrity Check
SELECT COUNT(*) AS orphaned_orders
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE c.id IS NULL;

SELECT COUNT(*) AS orphaned_attachments
FROM customer_attachments a
LEFT JOIN customers c ON a.customer_id = c.id
WHERE c.id IS NULL;

-- 3. Duplicate Detection on Primary Keys
SELECT id, COUNT(*) 
FROM customers 
GROUP BY id 
HAVING COUNT(*) > 1;

-- 4. Checkpoint & Batch Manifest Progression for Run
SELECT migration_run_id, batch_key, sequence_no, status, records_read, records_written, committed_at
FROM migration_batches
WHERE migration_run_id = 'MG-E2E-20261120-001'
ORDER BY sequence_no ASC;

SELECT migration_run_id, source_object, last_committed_cursor, updated_at
FROM migration_checkpoints
WHERE migration_run_id = 'MG-E2E-20261120-001';

-- 5. Final Run Status
SELECT id, status, started_at, completed_at, progress_json
FROM migration_runs
WHERE id = 'MG-E2E-20261120-001';
