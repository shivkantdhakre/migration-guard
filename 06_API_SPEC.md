# API Specification

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Proposed REST contract

## 1. API conventions

- Base path: `/api/v1`; JSON request/response.
- Authentication uses secure session or bearer token, depending on deployment.
- Authorization is workspace/project/resource scoped and checked on every request.
- IDs are UUID strings unless connector-native cursors/keys require another form.
- Timestamps use ISO 8601 with UTC timezone.
- Long-running work returns `202 Accepted` with job/run ID.
- Use cursor pagination for large datasets and enforce a maximum `limit`.
- Mutations that create asynchronous or privileged work accept `Idempotency-Key`.
- Never return secret values or full connection strings.

## 2. Common response envelopes

### Success

```json
{
  "data": {},
  "meta": { "requestId": "req_01...", "timestamp": "2026-11-19T12:00:00Z" }
}
```

### Error

```json
{
  "error": {
    "code": "MAPPING_VALIDATION_FAILED",
    "message": "The mapping contains unsupported conversion operations.",
    "details": [{ "path": "mappings[2].transform", "reason": "UNSUPPORTED_OPERATION" }],
    "requestId": "req_01..."
  }
}
```

Production errors must not expose stack traces, credentials, raw SQL or restricted source values.

## 3. Workspace and project APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Current user and memberships |
| GET / POST | `/workspaces` | List/create workspaces |
| GET | `/workspaces/{workspaceId}` | Workspace details |
| GET / POST | `/workspaces/{workspaceId}/members` | List/add members |
| PATCH | `/workspaces/{workspaceId}/members/{memberId}` | Change role |
| GET / POST | `/workspaces/{workspaceId}/projects` | List/create projects |
| GET / PATCH | `/projects/{projectId}` | Read/update project |
| GET | `/projects/{projectId}/activity` | Activity timeline |

## 4. Connection APIs

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/workspaces/{workspaceId}/connections` | List/create connection metadata |
| GET | `/connections/{connectionId}` | Get redacted connection details |
| PATCH | `/connections/{connectionId}` | Update non-secret configuration |
| POST | `/connections/{connectionId}/rotate-credentials` | Rotate credential |
| POST | `/connections/{connectionId}/test` | Test connectivity and capabilities |
| DELETE | `/connections/{connectionId}` | Disable/delete if not used by active runs |

### Create connection request

`POST /workspaces/{workspaceId}/connections`

```json
{
  "name": "Staging Mongo Source",
  "engine": "MONGODB",
  "connectionRole": "SOURCE",
  "config": {
    "host": "mongo.example.internal",
    "port": 27017,
    "database": "appdb",
    "tls": true,
    "authDatabase": "admin"
  },
  "credentials": {
    "username": "migration_reader",
    "password": "submitted-through-secure-input"
  }
}
```

Credential material must pass directly into the secret-storage boundary. It must not be written to normal logs or returned to the client.

### Create connection response

```json
{
  "data": {
    "id": "6a7a43d3-0000-4000-8000-000000000001",
    "name": "Staging Mongo Source",
    "engine": "MONGODB",
    "connectionRole": "SOURCE",
    "status": "UNTESTED",
    "credentialVersion": 1,
    "createdAt": "2026-11-19T12:00:00Z"
  }
}
```

## 5. Schema discovery and profiling APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/connections/{connectionId}/schema-discovery` | Enqueue discovery |
| GET | `/schema-discovery-jobs/{jobId}` | Discovery state |
| GET | `/connections/{connectionId}/schema-snapshots` | List snapshots |
| GET | `/schema-snapshots/{snapshotId}` | Read snapshot |
| POST | `/schema-snapshots/{snapshotId}/profiles` | Start bounded profiling |
| GET | `/profile-runs/{profileRunId}` | Profile status/results |
| POST | `/schema-snapshots/compare` | Compare two snapshots |

Example discovery request:

```json
{
  "scope": { "databases": ["appdb"], "collections": ["customers", "orders"] },
  "sample": { "enabled": true, "maxDocumentsPerCollection": 1000 }
}
```

## 6. Mapping APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects/{projectId}/mappings` | Create mapping profile |
| GET | `/mappings/{mappingId}` | Get profile |
| POST | `/mappings/{mappingId}/versions` | Create immutable mapping version |
| GET | `/mapping-versions/{versionId}` | Get mapping version |
| POST | `/mapping-versions/{versionId}/validate` | Validate mapping DSL |
| POST | `/mapping-versions/{versionId}/preview` | Preview sample transformation |
| POST | `/mapping-versions/{versionId}/ai-suggestions` | Request AI mapping suggestions |

Example mapping DSL:

```json
{
  "version": 1,
  "objects": [
    {
      "source": { "collection": "customers" },
      "destination": { "schema": "public", "table": "customers" },
      "identity": { "sourceKey": "_id", "destinationKey": "source_id", "strategy": "PRESERVE_AS_TEXT" },
      "fields": [
        { "sourcePath": "name", "destinationPath": "name", "transform": { "op": "TRIM_STRING" } },
        { "sourcePath": "createdAt", "destinationPath": "created_at", "transform": { "op": "PARSE_TIMESTAMP", "format": "AUTO_ISO_OR_EPOCH" } },
        { "sourcePath": "address", "destinationPath": "address", "transform": { "op": "TO_JSONB" } }
      ]
    }
  ]
}
```

The transform vocabulary is versioned and allowlisted. Never accept arbitrary code in the transform field.

## 7. Plan, dry-run and approval APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects/{projectId}/plans` | Create draft |
| GET | `/plans/{planId}` | Read plan |
| POST | `/plans/{planId}/versions` | Save immutable version |
| POST | `/plan-versions/{versionId}/readiness-check` | Deterministic readiness checks |
| POST | `/plan-versions/{versionId}/dry-runs` | Start dry run |
| GET | `/dry-runs/{dryRunId}` | Dry-run results |
| POST | `/plan-versions/{versionId}/approvals` | Approve/reject exact plan hash |
| POST | `/plan-versions/{versionId}/ai-plan` | Draft plan with AI |

Approval request:

```json
{
  "planHash": "sha256:...",
  "decision": "APPROVE",
  "comment": "Reviewed schema mapping and dry-run results."
}
```

## 8. Migration APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/plan-versions/{versionId}/runs` | Start approved migration |
| GET | `/migration-runs/{runId}` | Run details |
| GET | `/migration-runs/{runId}/progress` | Counts and throughput |
| GET | `/migration-runs/{runId}/batches` | Paginated batches |
| GET | `/migration-runs/{runId}/batches/{batchId}` | Batch details |
| POST | `/migration-runs/{runId}/pause` | Request pause |
| POST | `/migration-runs/{runId}/resume` | Resume eligible run |
| POST | `/migration-runs/{runId}/cancel` | Request cancellation |
| POST | `/migration-runs/{runId}/retry-failed` | Retry eligible failures |
| GET | `/migration-runs/{runId}/events` | Run timeline |

Example `202 Accepted` response:

```json
{
  "data": {
    "runId": "7c1cda51-0000-4000-8000-000000000001",
    "status": "QUEUED",
    "planHash": "sha256:...",
    "createdAt": "2026-11-19T12:00:00Z"
  }
}
```

## 9. Validation APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/migration-runs/{runId}/validations` | Start validation |
| GET | `/validation-runs/{validationRunId}` | Validation summary |
| GET | `/validation-runs/{validationRunId}/checks` | Check results |
| GET | `/validation-runs/{validationRunId}/discrepancies` | Filtered discrepancy list |
| GET | `/discrepancies/{discrepancyId}` | Discrepancy details/evidence |
| PATCH | `/discrepancies/{discrepancyId}` | Update investigation status/comment |
| POST | `/validation-runs/{validationRunId}/ai-analysis` | AI grouping/root-cause analysis |

Filters may include `category`, `severity`, `status`, `batchId`, `sourceKey`, `cursor` and `limit`.

## 10. AI copilot APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects/{projectId}/ai/conversations` | Create conversation |
| POST | `/ai/conversations/{conversationId}/messages` | Ask question / submit instruction |
| GET | `/ai/conversations/{conversationId}` | Conversation history/status |
| GET | `/ai/workflows/{workflowId}` | Workflow state/trace summary |
| POST | `/ai/proposals/{proposalId}/accept` | Accept into a new draft/version |
| POST | `/ai/proposals/{proposalId}/reject` | Reject proposal |

Response payloads should have typed fields such as `answer`, `facts`, `hypotheses`, `recommendations`, `evidenceRefs` and `proposalId`. Accepting a proposal creates a draft; it does not mutate an approved plan in place.

## 11. Reports and audit APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/validation-runs/{validationRunId}/reports` | Generate report |
| GET | `/reports/{reportId}` | Report metadata/status |
| GET | `/reports/{reportId}/download` | Authorized report download |
| GET | `/workspaces/{workspaceId}/audit-events` | Search audit events |
| GET | `/projects/{projectId}/audit-events` | Project timeline |

## 12. HTTP status codes

- `200`: successful read/update.
- `201`: created.
- `202`: asynchronous work accepted.
- `204`: successful delete/disable.
- `400`: malformed request.
- `401`: unauthenticated.
- `403`: unauthorized.
- `404`: absent or intentionally not visible.
- `409`: invalid state transition, stale version or idempotency conflict.
- `422`: schema/business validation failure.
- `429`: rate limit.
- `502/503`: dependency unavailable.

## 13. Idempotency and concurrency

Run creation, approvals, repair proposals and report requests should accept idempotency keys. Starting a run must fail if approval hash differs from plan hash. State-changing endpoints use optimistic concurrency or conditional updates. Repeated pause/resume requests should return current state without duplicate side effects.

## 14. API security

- Check workspace ownership on every resource path.
- Never trust client-supplied `workspaceId` without membership validation.
- AI tools use the initiating user's effective permissions and server-side policy.
- Redact secrets and sensitive values from error bodies.
- Enforce request-size, pagination and rate limits.
- Keep internal worker endpoints private and authenticated.

## 15. Versioning

Breaking changes require a new API version or migration window. Plan, mapping, transformation DSL and validation profile schemas are versioned independently because persisted runs may outlive an API release.
