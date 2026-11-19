# Architecture Decision Records (ADR)

**Product:** MigrationGuard · **Version:** 0.1 · **Status:** Initial decisions; revisit with evidence

Use this file to record material changes to the architecture. Decisions below are the working baseline, not a substitute for implementation review.

## ADR-001: Separate control plane and data plane

**Status:** Accepted  
**Decision:** User/project/plan/job management stays in control plane; bulk extraction, transform, load and validation run in workers.  
**Context:** Long-running data movement should not block web/API processes and has different scaling/failure characteristics.  
**Consequences:** More components to operate, but better isolation and independent scaling.

## ADR-002: Deterministic migration and validation; AI assists

**Status:** Accepted  
**Decision:** AI plans, suggests and explains. Deterministic workers execute approved plans; deterministic validators decide check outcomes.  
**Context:** Migration correctness needs repeatable, auditable evidence; LLM outputs are probabilistic.  
**Consequences:** Typed proposals, policy checks and approval flows are required. Core app remains useful without an LLM.

## ADR-003: MongoDB → PostgreSQL as first vertical slice

**Status:** Proposed baseline  
**Decision:** Prove one well-tested source-target route before adding many connectors.  
**Context:** Broad connector coverage multiplies data type, consistency and recovery edge cases.  
**Consequences:** Narrower initial coverage, faster validation of core architecture.

## ADR-004: PostgreSQL for control-plane metadata

**Status:** Accepted  
**Decision:** Use PostgreSQL for workspaces, projects, connections, plans, mappings, runs, batches, discrepancies, approvals and audit.  
**Context:** Control plane needs transactions, relations, indexes and JSONB for versioned configurations.  
**Consequences:** Requires schema migration discipline and separate configuration for customer destination DBs.

## ADR-005: Redis/BullMQ dispatches jobs, not data

**Status:** Accepted  
**Decision:** Queue messages carry IDs and small execution metadata; workers stream records from source to destination.  
**Context:** Bulk Redis payloads consume memory and complicate retries.  
**Consequences:** Workers load durable job context from the control DB and connector systems.

## ADR-006: At-least-once processing with idempotent effects

**Status:** Accepted  
**Decision:** Design for redelivery/restart using stable batch identity, idempotent writes and reconciliation of unknown outcomes.  
**Context:** A distributed transaction across source DB, destination DB, object storage, queue and control DB is generally unavailable.  
**Consequences:** Do not claim exactly-once semantics universally; some uncertain outcomes require operator review.

## ADR-007: Versioned mapping DSL rather than arbitrary scripts

**Status:** Accepted for MVP  
**Decision:** Use allowlisted deterministic transformations; arbitrary user scripts are out of scope.  
**Context:** Arbitrary code creates security, reproducibility and sandboxing risks.  
**Consequences:** Advanced transformations may need a future sandboxed extension model.

## ADR-008: LangGraph behind provider/tool boundaries

**Status:** Proposed  
**Decision:** Use LangGraph for multi-step AI workflows, with model providers and tools behind interfaces.  
**Context:** Planner and investigator workflows need explicit state, branching and bounded tool use.  
**Consequences:** Graphs/prompts require versioning and evaluation; deterministic features cannot depend on them.

## ADR-009: No universal rollback promise

**Status:** Accepted  
**Decision:** Provide scoped recovery plans, snapshots/manifests and supported compensating actions; do not promise universal rollback.  
**Context:** External systems have different transaction and deletion semantics.  
**Consequences:** Recovery is explicit and may depend on customer backups/restores.

## ADR-010: Defer CDC and integrate established technology

**Status:** Accepted for MVP  
**Decision:** Start with snapshot/batch migration; add CDC later through native facilities or established tools such as Debezium where appropriate.  
**Context:** General CDC requires log readers, offsets, ordering, schema evolution and connector-specific edge cases.  
**Consequences:** MVP is not a zero-downtime migration platform.

## ADR template

```text
## ADR-NNN: Title
Status: Proposed / Accepted / Superseded
Date:

### Context
What problem or constraint requires a decision?

### Options considered
1.
2.
3.

### Decision
What was selected and why?

### Consequences
Trade-offs, risks and follow-up work.

### Revisit trigger
What evidence or product change should cause this decision to be reviewed?
```
