# Migration Engine and Validation Design

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Proposed implementation baseline

## 1. Scope

The first implementation targets MongoDB to PostgreSQL with connector interfaces that allow future sources and destinations.

## 2. Processing pipeline

```mermaid
flowchart LR
 A[Source cursor] --> B[Read bounded batch]
 B --> C[Normalize source envelope]
 C --> D[Deterministic transform]
 D --> E[Validate target shape]
 E --> F[Write destination]
 F --> G[Persist ID map and manifest]
 G --> H[Commit checkpoint]
 H --> I[Schedule next batch]
```

A batch is not complete merely because data has been read or transformed.

## 3. Source record envelope

```ts
interface SourceRecordEnvelope {
  sourceObject: string;
  sourceKey: string;
  sourceVersion?: string;
  sourceCursor?: Record<string, unknown>;
  payload: unknown;
  extractedAt: string;
  attachmentRefs?: AttachmentReference[];
}
```

The connector owns native cursor handling; the engine owns stable envelope semantics and transformation invocation.

## 4. Transformation engine

### Rules

- Transformations are deterministic and versioned.
- Same input + same transform version produces same normalized output.
- Transform operations are allowlisted and parameter-validated.
- Unsupported types fail visibly; never silently stringify them.
- Precision loss, truncation, invalid date parsing and null/default substitution become warnings or failures according to policy.

### Initial operation vocabulary

`RENAME`, `TRIM_STRING`, `LOWERCASE`, `UPPERCASE`, `PARSE_INTEGER`, `PARSE_DECIMAL`, `PARSE_TIMESTAMP`, `TO_JSONB`, `FLATTEN_OBJECT`, `ARRAY_TO_CHILD_ROWS`, `SET_DEFAULT`, `NULL_IF_EMPTY`, `PRESERVE_SOURCE_ID`.

Do not execute arbitrary user JavaScript, Python or SQL transformations in the MVP.

## 5. Batching and concurrency

- Split runs into stable batches.
- Bound batch by record count and estimated payload bytes.
- Enforce run-level and connection-level concurrency limits.
- Apply backpressure when destination latency/errors or worker resource use grows.
- Avoid holding large documents or batches in memory longer than required.
- Route oversize records to explicit error handling.

## 6. Destination write modes

### Insert-only

Use for a new/empty target where key conflicts should fail.

### Upsert

Use stable unique keys and an explicit conflict/update-column policy. Do not blindly overwrite fields outside the mapping.

### Skip-existing

Only when explicitly configured. Record skipped keys so validation can account for them.

MVP should support insert-only and constrained upsert. Define null handling, conflict policy and update scope explicitly.

## 7. Idempotency and recovery

At-least-once batch processing is acceptable when destination effects are idempotent. Do not claim distributed exactly-once delivery.

### Batch commit sequence

1. Read a source page/batch and capture cursor boundary.
2. Create/load stable batch record.
3. Transform using approved mapping version.
4. Write using stable idempotency keys.
5. Persist ID mappings and manifest/counters.
6. Commit batch state and next checkpoint in control DB.
7. Dispatch next batch.

Where target and control DB cannot share a transaction, use durable intermediate states: `WRITE_STARTED`, `DESTINATION_WRITTEN`, `MANIFEST_COMMITTED`, `COMMITTED`. Recovery reconciles ambiguous states before advancing checkpoint.

### Crash behavior

| Crash point | Recovery |
|---|---|
| Before read | Re-dispatch batch |
| During read | Re-read same cursor range |
| During transform | Re-run deterministic transform |
| Before target write | Re-run batch |
| After target commit, before manifest | Reconcile stable keys/idempotency state; do not assume failure |
| After manifest, before checkpoint | Reconcile then commit checkpoint |
| After checkpoint commit | Do not replay unless explicit reprocess/retry action |

If write is non-idempotent and outcome unknown, stop for reconciliation.

## 8. Error classification

**Retryable examples:** temporary network issue before known commit, rate limit, temporary DB unavailability, safe deadlock/serialization failure.

**Non-retryable examples:** invalid value under strict policy, unsupported transform, missing required field, permission denied, schema mismatch requiring plan change.

**Unknown outcome:** network drops after destination may have accepted the write. Mark `OUTCOME_UNKNOWN`; reconcile by stable key/state before retry. AI may explain error but never determines retry safety.

## 9. Checkpoint format

Persist run and source object IDs, source cursor/start/end boundary, last committed batch sequence, plan/mapping version, consistency metadata and checkpoint timestamp. Advance only after required destination effects and manifests are durable.

## 10. MongoDB considerations

- Support only explicitly tested MongoDB versions and topology modes.
- Use stable pagination; avoid non-unique sort keys.
- Prefer `_id` where suitable; use compound cursors when required.
- Record read preference and consistency mode.
- Expect schema variation; profile and validate at runtime.
- Handle ObjectId, Decimal128, dates, binary, arrays and nested documents explicitly.
- Bound query duration, record size and batch memory.

## 11. PostgreSQL considerations

- Inspect constraints and indexes before migration.
- Use parameterized statements and safe bulk-load APIs.
- Validate schema/table/column identifiers against discovered metadata; never interpolate untrusted identifiers.
- Handle transaction size and lock duration.
- Preserve source identity in a dedicated column or ID mapping table when needed.
- Do not silently disable constraints. If deferral is required, declare it in the plan and validate after load.

## 12. Attachment/object migration

Use a separate attachment adapter. Manifest fields: source object reference, source record key/field path, destination object key, content type, expected byte size, source checksum, destination checksum, transfer state and retry count.

Flow:

1. Discover attachment references.
2. Verify source readability and metadata.
3. Stream bytes; do not load entire objects into memory.
4. Upload with deterministic destination key where appropriate.
5. Verify size and checksum.
6. Update DB reference only after object verification, or use an explicit staged state.
7. Record missing/failed objects as discrepancies.

## 13. Validation engine

### Checks

- Count reconciliation.
- Key-set reconciliation.
- Duplicate detection.
- Canonical content comparison.
- Type/nullability checks.
- Relationship/foreign-key checks.
- Attachment presence/size/checksum.
- Configured metadata comparison.
- Audit-event sequence checks where history is present and mapped.

### Canonicalization

Version and document rules for object key ordering, numeric precision, date/timezone normalization, null vs missing, array order, binary encoding, excluded/transformed fields and Unicode normalization. Do not normalize away meaningful differences.

### Hashing

Use cryptographic hashing such as SHA-256 over canonicalized content. Store hash algorithm and canonicalization version. Hash proves equality of the compared representation, not that the mapping preserved business meaning.

### Check states

`PASS`, `FAIL`, `SKIPPED`, `NOT_APPLICABLE`, `ERROR`. A run is validated only when required checks complete and no blocking discrepancy remains under policy. Accepted risks are explicit and audited.

## 14. Validation scalability

- Partition by source object and stable key range.
- Use aggregate DB queries for counts/duplicates where practical.
- Use manifests to avoid unnecessary repeated reads.
- Use full hashes for checks requiring sign-off; sampling must be labelled and cannot silently substitute for full verification.
- Support partial validation with explicit scope/status.

## 15. CDC / incremental synchronization (later)

Use MongoDB Change Streams or established CDC tooling as appropriate. Persist resume token/offset, separate snapshot boundary from CDC offset, preserve update/delete ordering, enforce idempotency, monitor lag/retention and reconcile final state before cutover. Do not write a generalized CDC system from scratch in MVP.

## 16. Test scenarios

10k small records; 100k mixed records; oversize record; high-cardinality arrays; destination throttling; worker kill at each stage; duplicate queue delivery; source disconnect during cursor; target disconnect during commit; and attachment checksum mismatch.
