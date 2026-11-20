# Destination SQL Verification Results for MG-E2E-20261120-001

- **Execution Timestamp:** 2026-11-19T22:47:38Z
- **Database:** Neon Cloud PostgreSQL (`neondb`)
- **Correlation ID (Table Filter):** `MG-E2E-20261120-001`
- **PostgreSQL Migration Run UUID:** `36988c91-405c-41fe-9919-e01377cf0033`

---

## 1. Destination Row Counts

```sql
SELECT COUNT(*) AS total_customers FROM customers WHERE run_id = 'MG-E2E-20261120-001';
-- Result: 1000

SELECT COUNT(*) AS total_orders FROM orders WHERE run_id = 'MG-E2E-20261120-001';
-- Result: 2028

SELECT COUNT(*) AS total_attachments FROM customer_attachments WHERE run_id = 'MG-E2E-20261120-001';
-- Result: 363
```

- **Customers:** 1,000 (Source: 1,000) — **100% Match**
- **Orders:** 2,028 (Source: 2,028) — **100% Match**
- **Customer Attachments:** 363 (Source: 363) — **100% Match**
- **Physical S3 Binary Files:** 0 (MVP documented boundary; binary attachment transfer deferred to Phase 2)

---

## 2. Referential Integrity & Foreign Key Checks

```sql
SELECT COUNT(*) AS orphaned_orders
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.id
WHERE o.run_id = 'MG-E2E-20261120-001' AND c.id IS NULL;
-- Result: 0

SELECT COUNT(*) AS orphaned_attachments
FROM customer_attachments a
LEFT JOIN customers c ON a.customer_id = c.id
WHERE a.run_id = 'MG-E2E-20261120-001' AND c.id IS NULL;
-- Result: 0
```

- **Orphaned Orders (FK Violations):** `0`
- **Orphaned Customer Attachments (FK Violations):** `0`

---

## 3. Duplicate Detection on Primary Keys

```sql
SELECT id, COUNT(*) AS dup_count
FROM customers 
WHERE run_id = 'MG-E2E-20261120-001'
GROUP BY id 
HAVING COUNT(*) > 1;
-- Result: 0 rows returned
```

- **Duplicate Customer Keys:** `0`

---

## 4. Persisted Checkpoint State in Control Plane

```sql
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
```

| Field | Value |
|---|---|
| **sourceObject** | `customers` |
| **lastCommittedBatchKey** | `batch_cust_004` |
| **lastCommittedSequenceNo** | `4` |
| **lastCommittedCursor.lastId** | `cust_001000` |
| **totalRecordsCommitted** | `1000` |
| **checkpointedAt** | `2026-11-19T22:47:32.708Z` |

---

## 5. All 15 Migration Batches (`migration_batches`)

```sql
SELECT batch_key, sequence_no, status, records_read, records_written, started_at, completed_at 
FROM migration_batches 
WHERE migration_run_id = '36988c91-405c-41fe-9919-e01377cf0033' 
ORDER BY sequence_no ASC;
```

| Batch Key | Seq | Target Object | Status | Read | Written | Started At | Completed At |
|---|:---:|---|:---:|:---:|:---:|---|---|
| `batch_cust_001` | 1 | `customers` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:29.574 | 2026-11-19 22:47:30.037 |
| `batch_cust_002` | 2 | `customers` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:30.394 | 2026-11-19 22:47:30.675 |
| `batch_cust_003` | 3 | `customers` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:30.931 | 2026-11-19 22:47:31.214 |
| `batch_cust_004` | 4 | `customers` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:31.469 | 2026-11-19 22:47:31.746 |
| `batch_ord_005` | 5 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:32.001 | 2026-11-19 22:47:32.279 |
| `batch_ord_006` | 6 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:32.448 | 2026-11-19 22:47:32.721 |
| `batch_ord_007` | 7 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:32.891 | 2026-11-19 22:47:33.166 |
| `batch_ord_008` | 8 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:33.336 | 2026-11-19 22:47:33.619 |
| `batch_ord_009` | 9 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:33.788 | 2026-11-19 22:47:34.064 |
| `batch_ord_010` | 10 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:34.235 | 2026-11-19 22:47:34.513 |
| `batch_ord_011` | 11 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:34.684 | 2026-11-19 22:47:34.963 |
| `batch_ord_012` | 12 | `orders` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:35.133 | 2026-11-19 22:47:35.406 |
| `batch_ord_013` | 13 | `orders` | `COMMITTED` | 28 | 28 | 2026-11-19 22:47:35.579 | 2026-11-19 22:47:35.840 |
| `batch_att_014` | 14 | `customer_attachments` | `COMMITTED` | 250 | 250 | 2026-11-19 22:47:36.009 | 2026-11-19 22:47:36.291 |
| `batch_att_015` | 15 | `customer_attachments` | `COMMITTED` | 113 | 113 | 2026-11-19 22:47:36.461 | 2026-11-19 22:47:36.729 |

---

## 6. Record Manifests (`record_manifests`)

```sql
SELECT source_object, status, COUNT(*) AS count 
FROM record_manifests 
WHERE migration_run_id = '36988c91-405c-41fe-9919-e01377cf0033' 
GROUP BY source_object, status 
ORDER BY source_object ASC;
```

- **`customer_attachments`:** `363` (`COMMITTED`)
- **`customers`:** `1,000` (`COMMITTED`)
- **`orders`:** `2,028` (`COMMITTED`)
- **Total Manifest Records:** `3,391`

---

## 7. Migration Run & Validation Run Verification

- **Migration Run ID:** `36988c91-405c-41fe-9919-e01377cf0033`
- **Migration Run Status:** `COMPLETED`
- **Validation Run ID:** `011ddec9-547f-4c0c-87b6-67bdd42cc65c`
- **Validation Engine Status:** `COMPLETED`
- **Validation Checks Evaluated:** **8 executed, 8 passed, 0 failed, 0 skipped**
- **Discrepancies:** `0`
