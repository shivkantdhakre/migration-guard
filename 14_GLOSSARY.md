# Glossary

| Term | Definition |
|---|---|
| AI-native | AI is part of important user workflows and system behavior, not a detached chatbot. In MigrationGuard, AI plans/investigates while deterministic services execute/verify. |
| Batch | Bounded group of source records processed as one scheduling/checkpoint unit. |
| Batch manifest | Durable record of what a batch attempted and wrote, including keys, counts and outcomes. |
| Canonicalization | Conversion of data into a defined normalized representation before comparison or hashing. |
| CDC | Change Data Capture; reads inserts, updates and deletes as they occur. |
| Checkpoint | Durable position showing which source range has been safely accounted for in the destination and manifest. |
| Connector | Adapter that reads from or writes to a specific source/destination technology. |
| Control plane | Services managing users, connections, plans, approvals, run state and metadata. |
| Data plane | Workers/connectors reading, transforming, writing and validating records. |
| Discrepancy | Persisted finding that a validation check detected a difference or failure. |
| Dry run | Bounded test execution against a sample or isolated target that does not mutate production data. |
| Idempotency | Repeating an operation does not create unintended additional effects. |
| ID mapping | Durable correspondence between a source identifier and destination identifier. |
| Migration plan | Versioned description of source, destination, scope, mapping, execution settings and validation profile. |
| Migration run | One execution of an approved plan version. |
| Mapping DSL | Versioned structured configuration describing field mappings and supported transformations. |
| RAG | Retrieval-Augmented Generation; providing a model with relevant retrieved context. |
| Reconciliation | Comparing source-derived expected state with actual destination state. |
| Snapshot migration | Initial bulk copy of a defined source state or boundary. |
| Source boundary | Cursor, timestamp, snapshot or other metadata defining which source data belongs to a run. |
| Transformation | Deterministic conversion/restructuring of source data into destination representation. |
| Validation profile | Versioned set of checks, comparison rules and acceptance thresholds. |
| Workspace | Tenant/security boundary containing users, projects, connections and migration records. |
