-- MigrationGuard Control Plane PostgreSQL DDL
-- Baseline Version 0.1

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workspace Members
CREATE TABLE IF NOT EXISTS workspace_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'Viewer', -- 'Owner', 'Admin', 'Engineer', 'Viewer'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_workspace_member UNIQUE (workspace_id, user_id)
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Connections
CREATE TABLE IF NOT EXISTS connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    engine TEXT NOT NULL, -- 'MONGODB', 'POSTGRESQL'
    connection_role TEXT NOT NULL, -- 'SOURCE', 'DESTINATION'
    config_json JSONB NOT NULL DEFAULT '{}',
    secret_ref TEXT,
    credential_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'UNTESTED', -- 'UNTESTED', 'HEALTHY', 'ERROR'
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Connection Vault Secrets (Encrypted credentials)
CREATE TABLE IF NOT EXISTS connection_secrets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    encrypted_payload TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_connection_secret_version UNIQUE (connection_id, version)
);

-- Schema Snapshots
CREATE TABLE IF NOT EXISTS schema_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    connection_version INTEGER NOT NULL DEFAULT 1,
    schema_version INTEGER NOT NULL DEFAULT 1,
    snapshot_json JSONB NOT NULL DEFAULT '{}',
    discovery_metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Profile Runs
CREATE TABLE IF NOT EXISTS profile_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    schema_snapshot_id UUID NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    summary_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration Plans
CREATE TABLE IF NOT EXISTS migration_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT', -- 'DRAFT', 'APPROVED', 'DEPRECATED'
    current_version INTEGER NOT NULL DEFAULT 1,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mapping Versions
CREATE TABLE IF NOT EXISTS mapping_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    mapping_json JSONB NOT NULL DEFAULT '{}',
    mapping_hash TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration Plan Versions
CREATE TABLE IF NOT EXISTS migration_plan_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id UUID NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    source_connection_id UUID NOT NULL REFERENCES connections(id),
    source_schema_snapshot_id UUID REFERENCES schema_snapshots(id),
    destination_connection_id UUID NOT NULL REFERENCES connections(id),
    destination_schema_snapshot_id UUID REFERENCES schema_snapshots(id),
    mapping_version_id UUID REFERENCES mapping_versions(id),
    scope_json JSONB NOT NULL DEFAULT '{}',
    execution_config_json JSONB NOT NULL DEFAULT '{}',
    validation_profile_json JSONB NOT NULL DEFAULT '{}',
    plan_hash TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Approvals
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL, -- 'PLAN_VERSION'
    resource_id UUID NOT NULL,
    resource_hash TEXT NOT NULL,
    approval_status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVE', 'REJECT'
    approver_user_id UUID NOT NULL REFERENCES users(id),
    comment TEXT,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration Runs
CREATE TABLE IF NOT EXISTS migration_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_version_id UUID NOT NULL REFERENCES migration_plan_versions(id),
    status TEXT NOT NULL DEFAULT 'QUEUED', -- 'QUEUED', 'RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED', 'FAILED'
    source_boundary_json JSONB NOT NULL DEFAULT '{}',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    progress_json JSONB NOT NULL DEFAULT '{"recordsRead": 0, "recordsWritten": 0, "recordsSkipped": 0, "recordsFailed": 0, "recordsPerSecond": 0}',
    last_error_code TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration Batches
CREATE TABLE IF NOT EXISTS migration_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    batch_key TEXT NOT NULL,
    sequence_no BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'QUEUED', 'RUNNING', 'COMMITTED', 'RETRY_WAIT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN'
    source_cursor_start JSONB,
    source_cursor_end JSONB,
    records_read BIGINT NOT NULL DEFAULT 0,
    records_written BIGINT NOT NULL DEFAULT 0,
    records_skipped BIGINT NOT NULL DEFAULT 0,
    records_failed BIGINT NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_summary JSONB,
    CONSTRAINT uq_batch_run_key UNIQUE (migration_run_id, batch_key)
);

-- ID Mappings
CREATE TABLE IF NOT EXISTS id_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    source_object TEXT NOT NULL,
    source_key TEXT NOT NULL,
    destination_object TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_id_mapping_source UNIQUE (migration_run_id, source_object, source_key)
);

-- Record Manifests
CREATE TABLE IF NOT EXISTS record_manifests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    migration_batch_id UUID REFERENCES migration_batches(id) ON DELETE CASCADE,
    source_object TEXT NOT NULL,
    source_key TEXT NOT NULL,
    destination_key TEXT,
    content_hash TEXT,
    status TEXT NOT NULL DEFAULT 'COMMITTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validation Runs
CREATE TABLE IF NOT EXISTS validation_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'QUEUED', -- 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'
    validation_profile_version TEXT NOT NULL DEFAULT '1.0',
    canonicalization_version TEXT NOT NULL DEFAULT '1.0',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    summary_json JSONB NOT NULL DEFAULT '{"totalChecks": 0, "passedChecks": 0, "failedChecks": 0, "discrepancies": 0}'
);

-- Validation Check Results
CREATE TABLE IF NOT EXISTS validation_check_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    validation_run_id UUID NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PASS', -- 'PASS', 'FAIL', 'SKIPPED', 'NOT_APPLICABLE', 'ERROR'
    evaluated_count BIGINT NOT NULL DEFAULT 0,
    passed_count BIGINT NOT NULL DEFAULT 0,
    failed_count BIGINT NOT NULL DEFAULT 0,
    skipped_count BIGINT NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    details_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Discrepancies
CREATE TABLE IF NOT EXISTS discrepancies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    validation_run_id UUID NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
    migration_batch_id UUID REFERENCES migration_batches(id) ON DELETE SET NULL,
    category TEXT NOT NULL, -- 'COUNT', 'MISSING_RECORD', 'EXTRA_RECORD', 'DUPLICATE', 'CONTENT_HASH', 'FIELD_VALUE', 'RELATIONSHIP', 'ATTACHMENT', 'METADATA'
    severity TEXT NOT NULL, -- 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    source_object TEXT NOT NULL,
    source_key_ref TEXT NOT NULL,
    destination_object TEXT,
    destination_key_ref TEXT,
    field_path TEXT,
    evidence_ref TEXT,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN', -- 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Events (Append-only)
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    actor_type TEXT NOT NULL DEFAULT 'USER', -- 'USER', 'SYSTEM', 'API_KEY'
    actor_id UUID NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    correlation_id TEXT,
    details_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Report Artifacts
CREATE TABLE IF NOT EXISTS report_artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    validation_run_id UUID REFERENCES validation_runs(id) ON DELETE CASCADE,
    migration_run_id UUID REFERENCES migration_runs(id) ON DELETE CASCADE,
    report_type TEXT NOT NULL, -- 'EXECUTIVE', 'DETAILED', 'AUDIT'
    format TEXT NOT NULL, -- 'HTML', 'CSV'
    storage_ref TEXT NOT NULL,
    checksum TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI Traces
CREATE TABLE IF NOT EXISTS ai_traces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    workflow_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_template_version TEXT NOT NULL,
    tools_used JSONB NOT NULL DEFAULT '[]',
    output_schema_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    usage_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance & Isolation Indexes
CREATE INDEX IF NOT EXISTS ix_workspaces_status ON workspaces (status);
CREATE INDEX IF NOT EXISTS ix_members_user ON workspace_members (user_id);
CREATE INDEX IF NOT EXISTS ix_projects_workspace ON projects (workspace_id);
CREATE INDEX IF NOT EXISTS ix_connections_workspace ON connections (workspace_id);
CREATE INDEX IF NOT EXISTS ix_snapshots_connection ON schema_snapshots (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_plans_workspace_project ON migration_plans (workspace_id, project_id);
CREATE INDEX IF NOT EXISTS ix_runs_workspace_status ON migration_runs (workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_batches_run_seq ON migration_batches (migration_run_id, sequence_no);
CREATE INDEX IF NOT EXISTS ix_discrepancies_validation_status ON discrepancies (validation_run_id, status, severity, category);
CREATE INDEX IF NOT EXISTS ix_audit_workspace_date ON audit_events (workspace_id, created_at DESC);
