-- MigrationGuard — Live Cloud Destination Verification Queries
-- Run Correlation Label: MG-E2E-20261120-001
-- PostgreSQL Migration Run UUID: 36988c91-405c-41fe-9919-e01377cf0033
-- Database: Neon Cloud PostgreSQL (neondb)
-- Note: UUID columns (migration_run_id, migration_runs.id) strictly require UUID literals.
--       Table run_id columns (customers.run_id, orders.run_id, customer_attachments.run_id) are VARCHAR(255).

-- 1. Baseline Destination Row Counts for Run MG-E2E-20261120-001
SELECT COUNT(*) AS total_customers 
FROM customers 
WHERE run_id = 'MG-E2E-20261120-001';

SELECT COUNT(*) AS total_orders 
FROM orders 
WHERE run_id = 'MG-E2E-20261120-001';

SELECT COUNT(*) AS total_attachments 
FROM customer_attachments 
WHERE run_id = 'MG-E2E-20261120-001';

-- 2. Foreign Key & Relational Integrity Checks
SELECT COUNT(*) AS orphaned_orders
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE o.run_id = 'MG-E2E-20261120-001' AND c.id IS NULL;

SELECT COUNT(*) AS orphaned_attachments
FROM customer_attachments a
LEFT JOIN customers c ON a.customer_id = c.id
WHERE a.run_id = 'MG-E2E-20261120-001' AND c.id IS NULL;

-- 3. Duplicate Detection on Primary Keys
SELECT id, COUNT(*) AS dup_count
FROM customers 
WHERE run_id = 'MG-E2E-20261120-001'
GROUP BY id 
HAVING COUNT(*) > 1;

-- 4. Checkpoint & High-Water Mark Progression
-- Checkpoint state is persisted monotonically to migration_runs.source_boundary_json
SELECT 
    id,
    source_boundary_json->>'sourceObject' AS checkpoint_source_object,
    source_boundary_json->>'lastCommittedBatchKey' AS checkpoint_batch_key,
    source_boundary_json->>'lastCommittedSequenceNo' AS checkpoint_seq_no,
    (source_boundary_json->'lastCommittedCursor'->>'lastId') AS checkpoint_cursor_id,
    source_boundary_json->>'totalRecordsCommitted' AS total_committed,
    source_boundary_json->>'checkpointedAt' AS checkpointed_at
FROM migration_runs
WHERE id = '36988c91-405c-41fe-9919-e01377cf0033';

-- 5. All 15 Migration Batch Records
SELECT 
    batch_key,
    sequence_no,
    status,
    records_read,
    records_written,
    records_skipped,
    records_failed,
    started_at,
    completed_at
FROM migration_batches
WHERE migration_run_id = '36988c91-405c-41fe-9919-e01377cf0033'
ORDER BY sequence_no ASC;

-- 6. Record Manifest Counts by Object and Status
SELECT 
    source_object,
    status,
    COUNT(*) AS manifest_record_count
FROM record_manifests
WHERE migration_run_id = '36988c91-405c-41fe-9919-e01377cf0033'
GROUP BY source_object, status
ORDER BY source_object ASC;

-- 7. Final Migration Run Status & Progress
SELECT 
    id,
    status,
    started_at,
    completed_at,
    progress_json->>'totalBatches' AS total_batches,
    progress_json->>'customers' AS customers_transferred,
    progress_json->>'orders' AS orders_transferred,
    progress_json->>'attachments' AS attachments_transferred
FROM migration_runs
WHERE id = '36988c91-405c-41fe-9919-e01377cf0033';

-- 8. Persisted Validation Run Record
SELECT 
    id,
    migration_run_id,
    status,
    started_at,
    completed_at,
    summary_json->>'overallState' AS overall_state,
    (summary_json->>'totalChecks')::int AS total_checks,
    (summary_json->>'passedChecks')::int AS passed_checks,
    (summary_json->>'failedChecks')::int AS failed_checks,
    (summary_json->>'totalDiscrepancies')::int AS total_discrepancies
FROM validation_runs
WHERE migration_run_id = '36988c91-405c-41fe-9919-e01377cf0033';
