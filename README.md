# MigrationGuard — AI-Native Data Migration & Assurance Platform

**Version:** 0.1.0 (Production MVP)  
**Baseline Date:** 20 November 2026  
**Status:** Remediated, Verified & Cloud-Integrated  

---

## 1. Overview

**MigrationGuard** is an enterprise data migration and assurance platform engineered to move data across heterogeneous storage engines (MongoDB → PostgreSQL) while providing mathematical, deterministic proof of data integrity.

### Core Engineering Principle
> **AI assists; deterministic systems execute and verify.**  
> LLMs assist with schema profiling, mapping discovery, natural language planning, root-cause failure investigation, and **human-reviewed remediation proposal generation**. AI agents never autonomously mutate destination data or execute automated repairs—all repair proposals are strictly constrained to an allowlist, saved in unapproved draft status, and require human operator approval. Deterministic algorithms, canonical hashing (RFC 8785), and stream validators move the records, manage recovery checkpoints, and decide whether data passed validation.

---

## 2. Monorepo Architecture

The repository is organized as a pnpm workspace monorepo:

```text
migration-guard/
├── packages/
│   ├── core/         # Domain models, RFC 8785 canonical hashing, Mapping DSL, 9-check ValidationEngine
│   ├── backend/      # NestJS Control Plane API, Auth (JWT), Vault (AES-256-GCM), BullMQ Producer, Reports
│   ├── worker/       # BullMQ Data Plane Consumer, Mongo/Postgres Connectors, Checkpoints, Idempotent Writers
│   └── frontend/     # Next.js 14 Console (App Router, Tailwind CSS, Lucide Icons, Copilot Drawer)
├── docs/             # 15 Architecture Specifications + Audit and Remediation Pack
│   ├── implementation-tracker.md   # Requirements Traceability Matrix (58/59 FRs; 1 deferred to Phase 2)
│   ├── REMEDIATION_CHANGELOG.md    # Post-audit engineering fixes and cloud integration log
│   ├── INTEGRATION_TEST_GUIDE.md   # Complete test execution instructions
│   ├── MVP_RELEASE_CHECKLIST.md    # Production MVP readiness verification
│   └── audit/                      # Independent technical audit reports
├── scripts/          # Synthetic dataset generation & fault injection benchmark runners
└── output/           # Downloadable assurance reports (HTML / CSV)
```

---

## 3. Live Cloud Infrastructure

MigrationGuard is fully integrated with live cloud infrastructure:

- **Control Plane & Destination Database:** Neon Cloud Serverless PostgreSQL (`<neon-postgres-cluster>` in AWS `ap-southeast-1`)
- **Distributed Job Queue:** Aiven Cloud Valkey Redis with TLS (`<aiven-valkey-host>:15678`)
- **AI Intelligence Engine:** Google Gemini Interactions API (`gemini-3.5-flash-lite`)
- **Assurance Report & Artifact Storage:** S3-compatible Object Storage (`<s3-storage-endpoint>`)

---

## 4. Quick Start

### Prerequisites
- Node.js `>= 22.0.0`
- pnpm `>= 9.0.0`

### 1. Installation & Environment
```bash
# Install monorepo dependencies
pnpm install

# Copy sample environment configuration
cp .env.example .env
```

Ensure `.env` contains valid credentials for PostgreSQL, Valkey Redis, and Gemini API.

### 2. Build All Packages
```bash
pnpm build
```

### 3. Launch Development Services
Run the three platform tiers in separate terminal sessions:

```bash
# Terminal 1: Control Plane Backend API (Port 4000)
pnpm dev:backend

# Terminal 2: Migration Data Plane Worker
pnpm dev:worker

# Terminal 3: Next.js Frontend Console (Port 3000)
pnpm dev:frontend
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 5. Testing & Verification

MigrationGuard features 100% test pass rates across all packages:

### Run Backend Integration Tests (69 tests across 16 files)
```bash
pnpm --filter @migrationguard/backend test
```

### Run Worker Execution Tests (41 tests across 11 files)
```bash
pnpm --filter @migrationguard/worker test
```

### Run the Deterministic 45-Defect Fault Injection Benchmark
```bash
# Executes native unit test suite (10,000 synthetic records with seed 1337):
pnpm test:fault-injection

# Run standalone CLI scenario generating HTML & CSV reports:
node --experimental-strip-types scripts/run-fault-injection.ts
```

Benchmark targets:
- 15 Missing Attachments (`ATTACHMENT`)
- 10 Duplicate Records (`DUPLICATE`)
- 8 Broken References (`RELATIONSHIP`)
- 12 Metadata Mismatches (`METADATA`)
- **Result:** Exactly 45 / 45 detected, 0 false positives.

---

## 6. Documentation Index

1. `01_PRD.md` — Product Requirements & Boundaries
2. `02_FRD.md` — Functional Requirements Matrix (54 FRs)
3. `03_NFR.md` — Non-Functional Requirements (P95 < 2s, 100% validation accuracy)
4. `04_SYSTEM_ARCHITECTURE.md` — Component topology & data flows
5. `05_DATA_MODEL.md` — 22 Relational schemas & JSON contracts
6. `06_API_SPEC.md` — REST OpenAPI specifications
7. `07_AI_AGENT_DESIGN.md` — 8 AI agents, prompt templates, tool sandboxing
8. `08_MIGRATION_ENGINE_DESIGN.md` — Streaming connectors, checkpoints, 9 validation checks
9. `09_SECURITY_PRIVACY_THREAT_MODEL.md` — STRIDE analysis, AES-256-GCM vault, token guards
10. `10_TEST_STRATEGY.md` — Multi-tiered testing strategy
11. `11_ROADMAP_DELIVERY_PLAN.md` — Delivery phases & epics
12. `12_OPERATIONS_RUNBOOKS.md` — Disaster recovery, backup & migration runbooks
13. `13_ARCHITECTURE_DECISIONS.md` — Architecture Decision Records (ADR 001–009)
14. `14_GLOSSARY.md` — Canonical terminology
15. `docs/REMEDIATION_CHANGELOG.md` — Complete audit remediation history
16. `docs/INTEGRATION_TEST_GUIDE.md` — End-to-end integration & cloud testing guide
17. `docs/MVP_RELEASE_CHECKLIST.md` — Production release verification checklist
