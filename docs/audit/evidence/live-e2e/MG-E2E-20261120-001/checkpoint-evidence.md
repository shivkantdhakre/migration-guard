# MigrationGuard — Checkpoint Progression & Batch Manifest Evidence
**Run Correlation Identifier:** `MG-E2E-20261120-001`  
**PostgreSQL Migration Run UUID:** `36988c91-405c-41fe-9919-e01377cf0033`  
**Target Database:** Neon Cloud PostgreSQL (`neondb`)  
**Audit Verification Date:** 20 November 2026  

---

## 1. Checkpoint Architecture in PostgreSQL Control Plane

In the MigrationGuard database schema (refer to `05_DATA_MODEL.md` and `packages/worker/src/engine/postgres-storage-adapters.ts`), migration checkpoint progression is durably tracked through two complementary mechanisms:

1. **High-Water Mark Boundary (`migration_runs.source_boundary_json`):**
   Stores the monotonic cursor, last committed batch key, sequence number, and cumulative record count for the primary extraction collection.
2. **Per-Batch State Ledger (`migration_batches`):**
   Stores every individual batch transition (`RUNNING` $\to$ `COMMITTED`), recording monotonic `sequence_no` (1 through 15), exact read/write quantities, and server timestamps (`started_at`, `completed_at`).
3. **Record-Level Manifest (`record_manifests`):**
   Stores primary key mapping and commit status for all 3,391 individual records.

---

## 2. Actual Persisted Checkpoint State (`migration_runs`)

Direct query from `migration_runs` where `id = '36988c91-405c-41fe-9919-e01377cf0033'`:

```json
{
  "sourceObject": "customers",
  "checkpointedAt": "2026-11-19T22:47:32.708Z",
  "migrationRunId": "36988c91-405c-41fe-9919-e01377cf0033",
  "lastCommittedCursor": {
    "lastId": "cust_001000"
  },
  "lastCommittedBatchKey": "batch_cust_004",
  "totalRecordsCommitted": 1000,
  "lastCommittedSequenceNo": 4
}
```

- **Primary Source Object:** `customers`
- **Last Committed Cursor:** `cust_001000` (Sequence 4)
- **Total Primary Records Committed:** `1,000`

---

## 3. Per-Object Batch Reconciliation (All 15 Batches)

The 15 executed batches represent the complete relational migration sequence:

### A. Customers (Batches 1 – 4)
| Batch Key | Seq | Read | Written | Status | Completed At (UTC) | Cursor High-Water Mark |
|---|:---:|:---:|:---:|:---:|---|---|
| `batch_cust_001` | 1 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:30.037 | `cust_000250` |
| `batch_cust_002` | 2 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:30.675 | `cust_000500` |
| `batch_cust_003` | 3 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:31.214 | `cust_000750` |
| `batch_cust_004` | 4 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:31.746 | `cust_001000` |

*Subtotal Customers:* **1,000 committed / 1,000 read** (0 skipped, 0 failed).

### B. Relational Orders (Batches 5 – 13)
| Batch Key | Seq | Read | Written | Status | Completed At (UTC) | Final Batch Key |
|---|:---:|:---:|:---:|:---:|---|---|
| `batch_ord_005` | 5 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:32.279 | `ord_0000250` |
| `batch_ord_006` | 6 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:32.721 | `ord_0000500` |
| `batch_ord_007` | 7 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:33.166 | `ord_0000750` |
| `batch_ord_008` | 8 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:33.619 | `ord_0001000` |
| `batch_ord_009` | 9 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:34.064 | `ord_0001250` |
| `batch_ord_010` | 10 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:34.513 | `ord_0001500` |
| `batch_ord_011` | 11 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:34.963 | `ord_0001750` |
| `batch_ord_012` | 12 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:35.406 | `ord_0002000` |
| `batch_ord_013` | 13 | 28 | 28 | `COMMITTED` | 2026-11-19 22:47:35.840 | `ord_0002028` |

*Subtotal Orders:* **2,028 committed / 2,028 read** (0 skipped, 0 failed).

### C. Customer Attachment Metadata (Batches 14 – 15)
| Batch Key | Seq | Read | Written | Status | Completed At (UTC) | Final Batch Key |
|---|:---:|:---:|:---:|:---:|---|---|
| `batch_att_014` | 14 | 250 | 250 | `COMMITTED` | 2026-11-19 22:47:36.291 | `att_000250` |
| `batch_att_015` | 15 | 113 | 113 | `COMMITTED` | 2026-11-19 22:47:36.729 | `att_000363` |

*Subtotal Attachments:* **363 committed / 363 read** (0 skipped, 0 failed).

---

## 4. Reconciled Totals

- **Total Monotonic Sequence Range:** `1` through `15`
- **Total Records Accounted in Batches:** `3,391`
- **Total Records Accounted in Manifests:** `3,391`
- **Missing or Dropped Records:** `0`
- **Failed Batches / Retries:** `0`
- **PostgreSQL Final Run State:** `COMPLETED` at `2026-11-19 22:47:36.900 UTC`
