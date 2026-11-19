# MigrationGuard — Source Verification Report
**Run ID:** `MG-E2E-20261120-001`  
**Seed:** `42`  
**Timestamp:** `2026-11-20T03:34:00Z`  

---

## 1. Planned Source Dataset Specification

The deterministic source dataset specification for `MG-E2E-20261120-001` requires:

| Entity | Planned Record Count | Unique Key Schema | Validation Criteria |
|---|---:|---|---|
| **Customers** | 1,000 | `_id: String` (`cust_000001` - `cust_001000`) | Valid email, ISO-8601 created_at, trimmed name |
| **Orders** | 2,500 | `_id: String` (`ord_000001` - `ord_002500`) | FK reference to valid Customer ID |
| **Attachment Metadata** | 1,500 | `_id: String` (`att_000001` - `att_001500`) | FK reference to valid Customer ID, SHA-256 hash |
| **Physical S3 Objects** | 0 | None (MVP Scope limitation) | 0 physical binaries expected in MVP |

---

## 2. Ingestion Status in MongoDB

* **Actual MongoDB Connection:** Not established (`MONGO_URL` unconfigured).
* **Source Records Seeded:** 0 (Seeding halted due to missing MongoDB connection).
* **Integrity Status:** N/A (Seeding blocked at preflight).
