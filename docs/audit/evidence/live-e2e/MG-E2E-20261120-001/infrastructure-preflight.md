# MigrationGuard — Infrastructure Preflight Report
**Run ID:** `MG-E2E-20261120-001`  
**Timestamp:** `2026-11-20T03:34:00Z`  
**Auditor:** Release Engineering  

---

## 1. Environment Variable Audit

| Variable Name | Status in `.env` | Purpose | Required For Live E2E |
|---|---|---|---|
| `DATABASE_URL` | Configured | Destination PostgreSQL & Control Plane | Yes (Neon Cloud) |
| `REDIS_URL` | Configured | Distributed Queue (BullMQ) | Yes (Aiven Valkey Cloud) |
| `REDIS_TLS` | Configured (`true`) | TLS encryption for Valkey | Yes |
| `MONGO_URL` | **MISSING** | Source MongoDB cluster connection string | **Yes (Blocker)** |
| `GEMINI_API_KEY` | Configured | AI Copilot / Failure Analysis | Optional for baseline migration |
| `ENCRYPTION_KEY` | Configured | AES-256-GCM Vault Master Key | Yes |
| `JWT_SECRET` | Configured | Control Plane Authentication | Yes |

*Note: All values remain unredacted in local `.env` and are strictly excluded from git tracking via `.gitignore`.*

---

## 2. Infrastructure Connectivity Matrix

| Service | Target Host / Hostname (Sanitized) | Tested Endpoint | Result | Failure Detail / Blocker |
|---|---|---|:---:|---|
| **MongoDB Source** | Not Configured | `localhost:27017` / Remote URI | **FAIL** | `MONGO_URL` missing; local `mongod.exe` exists but is not running. |
| **Neon PostgreSQL Destination** | `ep-billowing-block-*.aws.neon.tech` | Port 5432 (SSL require) | **BLOCKED** | Sandbox network isolation blocks DNS (`getaddrinfo ENOTFOUND`); user denied unsandboxed bypass. |
| **Aiven Valkey Redis** | `valkey-137cc70c-*.aivencloud.com` | Port 15678 (TLS rediss) | **BLOCKED** | Sandbox network isolation blocks DNS (`getaddrinfo ENOTFOUND`); user denied unsandboxed bypass. |
| **NestJS Backend** | `localhost:4000` | HTTP `/health` | **NOT STARTED** | Halted at preflight due to missing MongoDB and cloud connectivity blocks. |
| **Migration Worker** | Local daemon | BullMQ `migration-execution` | **NOT STARTED** | Halted at preflight due to missing queue connection. |

---

## 3. Preflight Conclusion

Preflight verification **FAILED** due to:
1. Missing `MONGO_URL` environment variable.
2. Network sandboxing preventing agent access to remote cloud infrastructure (user denied unsandboxed bypass permission).
3. Zero-fallback policy: In accordance with prompt instructions, mock providers, in-memory databases, and synthetic writers were explicitly **not** engaged.
