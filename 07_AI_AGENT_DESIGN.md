# AI Agent and AI-Native Workflow Design

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Proposed design

## 1. AI design principle

> AI proposes and explains. Typed application services validate. Deterministic workers execute. Deterministic validators decide whether checks pass.

AI is embedded in planning and troubleshooting, not used as the source of truth for data movement or integrity.

## 2. AI capabilities

| Capability | Trigger | Output | Boundary |
|---|---|---|---|
| Migration Planner | User describes migration | Draft plan, assumptions, questions, risks | Review and plan validator required |
| Schema Mapping Assistant | User asks to map fields | Proposed mappings and rationale | New draft mapping version only |
| Transformation Assistant | Ambiguous conversion | Suggested allowlisted operation | Sample preview required |
| Risk Analyst | Readiness check | Risk narrative linked to facts | Rule checks remain authoritative |
| Failure Investigator | Run/batch failure | Root-cause hypotheses and diagnostics | Cannot change retry classification |
| Discrepancy Investigator | Validation finished | Issue clusters and hypotheses | Must link to original discrepancy IDs |
| Repair Planner | User requests fix | Draft bounded repair operation | Allowlist, dry run and approval |
| Report Narrator | Report requested | Plain-language summary | Figures sourced from persisted results |

## 3. Workflows

### 3.1 Planner graph

Inputs: user objective, selected connections, schema snapshots, aggregate profiles, connector capabilities and policy. Outputs: draft plan, mapping proposals, assumptions, unresolved questions and risk list.

Recommended graph nodes:

1. `load_authorized_context`
2. `inspect_source_and_target_metadata`
3. `identify_structural_differences`
4. `draft_mapping_and_strategy`
5. `validate_proposal_schema`
6. `run_deterministic_plan_checks`
7. `produce_reviewable_draft`

The planner cannot start a migration or write to a destination.

### 3.2 Mapping workflow

- Match exact field names first.
- Consider source/target data-type compatibility.
- Use masked sample patterns only when policy allows.
- Detect structures such as embedded arrays that may need child tables.
- Mark ambiguous mappings unresolved instead of inventing business semantics.
- Include assumptions, rationale, confidence and test requirement.

Confidence is advisory, not a substitute for review or validation.

### 3.3 Failure investigator

Inputs: sanitized error codes, connector details, batch metadata, transformation version and run events. Output: root-cause hypotheses, affected batch/record refs and next diagnostic steps. It may call allowlisted diagnostic tools but cannot execute a repair.

### 3.4 Discrepancy investigator

Inputs: persisted discrepancy IDs and evidence. Output: clusters, common patterns and suggested checks. Example: group records with the same timestamp parse error. Any causal explanation not directly proven must be labeled a hypothesis.

### 3.5 Repair planner (Human-Reviewed Remediation Proposal Generation)

The Repair Planner is strictly a **proposal generation agent**, not an automated repair execution or database mutation engine. It generates structured, bounded recommendations for human operator review and sign-off. Automated execution, background patching, and autonomous rollback pipelines are out-of-scope and deferred; any remediation action must be executed by an authorized human operator.

May propose only allowlisted operations:

- `RETRY_FAILED_BATCH`
- `REPROCESS_RECORDS_WITH_APPROVED_MAPPING`
- `REUPLOAD_MISSING_ATTACHMENT`
- `REBUILD_ID_MAPPING`
- `MARK_EXCEPTION_FOR_REVIEW`

It must not emit arbitrary SQL, shell commands or free-form executable scripts. All generated proposals:
1. Are saved in unapproved draft status (`PENDING_REVIEW`).
2. Require explicit human operator approval and dry-run validation before any operational change is applied.
3. Explicitly state preconditions, affected keys, and operational risks.

## 4. Tool catalog

| Tool | Access | Purpose |
|---|---|---|
| `get_schema_snapshot` | Read | Selected schema snapshot |
| `get_profile_summary` | Read | Aggregate profile |
| `get_connector_capabilities` | Read | Supported features/limitations |
| `get_mapping_version` | Read | Mapping DSL and version |
| `preview_transform` | Sandboxed test | Run mapping on bounded fixture |
| `get_run_summary` | Read | Run counters/state |
| `get_batch_errors` | Read | Sanitized errors |
| `get_discrepancy_evidence` | Read | Selected validation evidence |
| `compare_sample_records` | Read | Normalized sample comparison |
| `validate_plan_draft` | Validation | Check plan against schema and policy |
| `create_draft_proposal` | Draft write | Persist unapproved proposal |
| `request_human_approval` | Workflow | Start an approval workflow |

No tool accepts arbitrary SQL, shell commands or raw connection strings from the model.

### Tool authorization contract

Every call must independently validate user/service identity, workspace membership, project/run ownership, allowed operation, resource state, input schema, maximum result size, timeout and data classification. Never trust the model to choose its own authorization scope.

## 5. Structured outputs

All model output is parsed and validated against versioned JSON schemas. Example mapping proposal:

```json
{
  "schemaVersion": "mapping-proposal.v1",
  "proposals": [
    {
      "sourcePath": "customer_name",
      "destinationPath": "name",
      "transform": { "op": "TRIM_STRING" },
      "confidence": 0.93,
      "rationale": "The source and destination fields appear semantically aligned.",
      "assumptions": [],
      "requiresReview": true
    }
  ],
  "unresolved": [
    {
      "sourcePath": "orders",
      "reason": "Destination child-table relationship is not defined.",
      "question": "Should each embedded order become a separate row?"
    }
  ]
}
```

Example repair proposal:

```json
{
  "schemaVersion": "repair-proposal.v1",
  "operation": "REPROCESS_RECORDS_WITH_APPROVED_MAPPING",
  "scope": { "validationRunId": "uuid", "discrepancyIds": ["uuid-1", "uuid-2"] },
  "mappingVersionId": "uuid",
  "preconditions": ["Mapping passed preview tests."],
  "expectedEffects": ["Reprocess only the listed source keys."],
  "risks": ["Destination fields may be overwritten according to write policy."],
  "requiresDryRun": true,
  "requiresApproval": true
}
```

Backend independently checks every referenced resource and operation.

## 6. LangGraph implementation guidance

Use explicit state, bounded loops and terminal outcomes. Example:

```ts
type PlannerState = {
  workspaceId: string;
  projectId: string;
  actorId: string;
  userObjective: string;
  sourceSnapshotId: string;
  targetSnapshotId: string;
  profileRefs: string[];
  policySnapshotId: string;
  proposal?: MigrationPlanProposal;
  deterministicFindings: PlanFinding[];
  unresolvedQuestions: string[];
  status: "RUNNING" | "NEEDS_INPUT" | "DRAFT_READY" | "REJECTED" | "FAILED";
};
```

Rules:

- Validate input before graph start.
- Store large evidence outside graph state and reference it by ID.
- Bound model retries, tool calls, output tokens and runtime.
- Time out every external request.
- Return `NEEDS_INPUT` when business semantics are ambiguous.
- Store graph/prompt/output-schema versions.
- Do not resume stale workflows after policy or plan versions change.

## 7. RAG and retrieval

Potential corpus: connector documentation, internal runbooks, versioned transformation docs, approved reusable migration patterns and sanitized failure resolutions.

pgvector or Qdrant can support semantic retrieval when useful. Apply workspace authorization filters before retrieval; similarity is not permission. Do not embed every source customer record by default. Prefer documentation, schema descriptions, aggregates and sanitized lessons learned.

## 8. Privacy policy for AI context

### Allowed by default (subject to workspace policy)

- Schema metadata and field paths.
- Data types, nullability and constraints.
- Aggregate counts/percentages.
- Sanitized error codes and stack summaries.
- Masked sample values.
- Internal MigrationGuard resource IDs.

### Excluded by default

- Passwords, connection strings, tokens and private keys.
- Full unmasked production rows.
- Raw attachments or large document contents.
- PII/sensitive content unless a documented opt-in feature requires it.
- SQL logs containing raw values.

## 9. Prompt injection and untrusted data

Schema comments, document content, errors, filenames, table names and retrieved documents are untrusted data. They may contain instruction-like text.

Controls:

- Treat retrieved/source content as data, never system instructions.
- Keep application policy separate from retrieved text.
- Use server-side allowlisted tools and authorization.
- Model cannot grant itself permissions or change workspace scope.
- Ignore instructions discovered inside source records/files.
- Validate structured output; never execute model-generated code.

## 10. Approval matrix

| Action | AI without approval? | Control |
|---|---|---|
| Explain schema | Yes | Read authorization |
| Suggest mapping | Yes | Draft proposal only |
| Save proposal | Draft only | New version; user accepts |
| Preview sample transform | Yes, bounded | No production writes |
| Generate plan | Draft only | Deterministic checks + human approval |
| Start production migration | No | Approved plan hash and user authorization |
| Retry production batch | No | Policy and user/operator authorization |
| Modify destination | No | Allowlisted repair, dry run and approval |
| Mark validation passed | Never | Deterministic validator only |

## 11. Evaluation strategy

Build a versioned evaluation set for straightforward and ambiguous mappings, nested arrays, incompatible conversions, prompt injection in source content, cross-workspace access attempts, misleading logs, unsupported repair actions and false claims of successful validation.

Measure schema-valid output rate, mapping precision on reviewed cases, correct clarification/abstention rate, unauthorized tool rejection, unsupported-operation rejection, evidence traceability, latency and cost. Correct abstention is a positive result.

## 12. Observability and failure handling

Record provider/model, prompt template, graph version, redacted tool calls, output schema version, latency, retry count, status and usage metadata. Avoid unnecessary raw prompts.

- Provider unavailable: core app remains functional.
- Invalid output: reject; at most one bounded correction retry.
- Tool timeout: return partial result and mark missing evidence.
- Authorization failure: stop; never retry with broader credentials.
- Ambiguous mapping: request user input.
- Policy violation: reject proposal and log security event.
