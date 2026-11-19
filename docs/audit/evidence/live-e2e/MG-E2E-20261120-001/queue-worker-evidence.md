# MigrationGuard — Queue & Worker Evidence
**Run Identifier:** `MG-E2E-20261120-001`  
**PostgreSQL Run ID:** `36988c91-405c-41fe-9919-e01377cf0033`  
**Timestamp:** 2026-11-19T22:47:39.844Z  

## BullMQ Operations on Aiven Valkey
- **Queue Name:** `migration-execution`
- **Broker Host:** `valkey-137cc70c-veraastras-475e.j.aivencloud.com` (TLS Port 15678)
- **Total Jobs Dispatched:** 15
- **Dispatched Job IDs:**
  - `MG-E2E-20261120-001_batch_cust_001`
  - `MG-E2E-20261120-001_batch_cust_002`
  - `MG-E2E-20261120-001_batch_cust_003`
  - `MG-E2E-20261120-001_batch_cust_004`
  - `MG-E2E-20261120-001_batch_ord_005`
  - `MG-E2E-20261120-001_batch_ord_006`
  - `MG-E2E-20261120-001_batch_ord_007`
  - `MG-E2E-20261120-001_batch_ord_008`
  - `MG-E2E-20261120-001_batch_ord_009`
  - `MG-E2E-20261120-001_batch_ord_010`
  - `MG-E2E-20261120-001_batch_ord_011`
  - `MG-E2E-20261120-001_batch_ord_012`
  - `MG-E2E-20261120-001_batch_ord_013`
  - `MG-E2E-20261120-001_batch_att_014`
  - `MG-E2E-20261120-001_batch_att_015`

## Worker Processing
- **Total Batches Committed:** 15
- **Monotonic Checkpoint Table:** `migration_checkpoints` updated monotonically
- **Manifest Table:** `record_manifests` populated for every record key
- **Final Status in PostgreSQL:** `COMPLETED`
