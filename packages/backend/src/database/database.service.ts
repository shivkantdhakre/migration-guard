import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { appConfig } from '../config/configuration';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: pg.Pool | null = null;
  private isConnected = false;
  private customDatabaseUrl?: string;
  private customSearchPath?: string;

  constructor(customDatabaseUrl?: string, customSearchPath?: string) {
    this.customDatabaseUrl = customDatabaseUrl;
    this.customSearchPath = customSearchPath;
  }

  // In-memory relational store fallback for unit testing or explicitly enabled offline dev
  private memoryStore: Map<string, Map<string, any>> = new Map();

  public static normalizeIpHost(host: string): string {
    if (!host) return '';
    const clean = host.replace(/^\[|\]$/g, '').toLowerCase().trim();

    // Handle IPv4-mapped IPv6 in hex: e.g. ::ffff:7f00:1 or 0:0:0:0:0:ffff:7f00:1
    const ipv4MappedHex = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(clean);
    if (ipv4MappedHex) {
      const high = parseInt(ipv4MappedHex[1], 16);
      const low = parseInt(ipv4MappedHex[2], 16);
      const b1 = (high >> 8) & 0xff;
      const b2 = high & 0xff;
      const b3 = (low >> 8) & 0xff;
      const b4 = low & 0xff;
      return `${b1}.${b2}.${b3}.${b4}`;
    }

    // Handle IPv4-mapped IPv6 in dotted decimal: ::ffff:127.0.0.1
    const ipv4MappedDot = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
    if (ipv4MappedDot) {
      return ipv4MappedDot[1];
    }

    // Handle fully expanded IPv6 loopback and unspecified
    if (/^(0+:){7}0*1$/.test(clean)) {
      return '::1';
    }
    if (/^(0+:){7}0*0$/.test(clean)) {
      return '::';
    }

    return clean;
  }

  public static isLoopbackHost(host: string): boolean {
    if (!host) return false;
    const normalized = DatabaseService.normalizeIpHost(host);
    return (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized.startsWith('127.')
    );
  }

  public static isUnspecifiedHost(host: string): boolean {
    if (!host) return false;
    const normalized = DatabaseService.normalizeIpHost(host);
    return normalized === '0.0.0.0' || normalized === '::';
  }

  public static isUnsafeProductionHost(host: string): boolean {
    return DatabaseService.isLoopbackHost(host) || DatabaseService.isUnspecifiedHost(host);
  }

  async onModuleInit() {
    this.initMemoryTables();
    const isInMemoryAllowed = process.env.ALLOW_IN_MEMORY_DB === 'true';

    // In unit test mode with in-memory explicitly allowed and not forced to use PostgreSQL,
    // use in-memory store for unit test speed and data isolation
    if (isInMemoryAllowed && process.env.NODE_ENV === 'test' && process.env.FORCE_POSTGRES_DB !== 'true') {
      this.isConnected = false;
      return;
    }

    const effectiveDbUrl =
      this.customDatabaseUrl ||
      (process.env.NODE_ENV === 'test' &&
        (process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL)) ||
      appConfig.databaseUrl;

    const isLocal = (() => {
      try {
        const parsed = new URL(effectiveDbUrl);
        return DatabaseService.isLoopbackHost(parsed.hostname);
      } catch {
        const match = /@([^:/]+|\[[^\]]+\])/.exec(effectiveDbUrl);
        return match ? DatabaseService.isLoopbackHost(match[1]) : false;
      }
    })();

    const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true';
    const isProduction = process.env.NODE_ENV === 'production';
    if (allowInsecureTls && isProduction) {
      throw new Error('[Security] Insecure TLS (ALLOW_INSECURE_TLS=true) is strictly forbidden in production.');
    }
    const ssl = isLocal && !isProduction ? false : { rejectUnauthorized: !allowInsecureTls };

    try {
      const poolConfig: pg.PoolConfig = {
        connectionString: effectiveDbUrl,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
        max: 10,
        ssl,
      };
      if (this.customSearchPath) {
        poolConfig.options = `-c search_path=${this.customSearchPath}`;
      }
      this.pool = new pg.Pool(poolConfig);
      this.pool.on('error', (err) => {
        console.warn(`[DatabaseService] Idle client pool notice: ${err.message}`);
      });

      if (this.customSearchPath) {
        this.pool.on('connect', (c) => {
          c.query(`SET search_path TO ${this.customSearchPath}`).catch(() => {});
        });
      }

      const client = await this.pool.connect();
      if (this.customSearchPath) {
        await client.query(`SET search_path TO ${this.customSearchPath}`);
      }
      client.release();
      this.isConnected = true;
      console.log('[DatabaseService] Connected to PostgreSQL successfully.');
      await this.runMigrations();
    } catch (err: any) {
      this.isConnected = false;
      if (isProduction) {
        console.error(`[DatabaseService] CRITICAL: Failed to connect to mandatory PostgreSQL in production (${err.message}).`);
        throw new Error(
          `[DatabaseService] CRITICAL: PostgreSQL connection is strictly required in production (NODE_ENV=production): ${err.message}`,
        );
      }
      if (!isInMemoryAllowed) {
        console.error(`[DatabaseService] CRITICAL: Failed to connect to mandatory PostgreSQL (${err.message}).`);
        throw new Error(
          `[DatabaseService] Database connection failed and in-memory fallback is disabled: ${err.message}`,
        );
      }
      console.warn(
        `[DatabaseService] PostgreSQL not available (${err.message}). Using built-in memory store (ALLOW_IN_MEMORY_DB=true).`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
    }
  }

  public get isDbConnected(): boolean {
    return this.isConnected;
  }

  public async ping(): Promise<boolean> {
    if (!this.isConnected || !this.pool) {
      return false;
    }
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private initMemoryTables() {
    const tables = [
      'workspaces',
      'users',
      'workspace_members',
      'projects',
      'connections',
      'connection_secrets',
      'schema_snapshots',
      'profile_runs',
      'migration_plans',
      'migration_plan_versions',
      'mapping_versions',
      'approvals',
      'migration_runs',
      'migration_batches',
      'id_mappings',
      'record_manifests',
      'record_manifest_historical_archive',
      'manifest_reconciliation_reports',
      'validation_runs',
      'validation_check_results',
      'discrepancies',
      'audit_events',
      'report_artifacts',
      'ai_traces',
    ];
    for (const t of tables) {
      if (!this.memoryStore.has(t)) {
        this.memoryStore.set(t, new Map());
      }
    }
  }

  public resetMemoryStore() {
    for (const [, tableMap] of this.memoryStore) {
      tableMap.clear();
    }
  }

  public async runMigrations() {
    if (!this.isConnected || !this.pool) return;
    const client = await this.pool.connect();
    const lockKey = `migrationguard_schema_migrations_${this.customSearchPath || 'default'}`;
    try {
      if (this.customSearchPath) {
        await client.query(`SET search_path TO ${this.customSearchPath}`);
      }
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      try {
        const candidates = [
          path.join(__dirname, 'schema.sql'),
          path.join(__dirname, '..', 'src', 'database', 'schema.sql'),
          path.resolve(process.cwd(), 'packages/backend/src/database/schema.sql'),
          path.resolve(process.cwd(), 'src/database/schema.sql'),
        ];
        const sqlPath = candidates.find((p) => fs.existsSync(p));
        if (sqlPath) {
          const sql = fs.readFileSync(sqlPath, 'utf8');
          await client.query(sql);
          console.log(`[DatabaseService] Migrations executed successfully on schema: ${this.customSearchPath || 'public'}.`);
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
      }
    } catch (err: any) {
      console.error('[DatabaseService] Migration failed:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run 005.16: Safe Manifest Uniqueness Upgrade & Historical Reconciliation (PRESERVE_LATEST_AND_ARCHIVE_SUPERSEDED)
   * Recovers exact destination coordinates from authoritative id_mappings (without fabrication),
   * recovers and validates batch relationships, detects duplicates, archives unresolvable and superseded
   * evidence without data loss, and records explicit audit reports.
   */
  public async reconcileManifestDuplicates(migrationRunId?: string): Promise<{
    duplicatesDetected: number;
    distinctIdentitiesAffected: number;
    archivedCount: number;
    resolvedCoordinatesCount: number;
    unresolvedCoordinatesArchived: number;
    unresolvedBatchArchived: number;
    reportId?: string;
    details: any[];
  }> {
    if (!this.isConnected || !this.pool) {
      return {
        duplicatesDetected: 0,
        distinctIdentitiesAffected: 0,
        archivedCount: 0,
        resolvedCoordinatesCount: 0,
        unresolvedCoordinatesArchived: 0,
        unresolvedBatchArchived: 0,
        details: [],
      };
    }

    return this.transaction(async (client) => {
      // Step 0: Acquire PostgreSQL advisory transaction lock for serialization
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['migrationguard_schema_migrations']);
      await client.query('LOCK TABLE record_manifests IN EXCLUSIVE MODE');
      await client.query('LOCK TABLE migration_batches IN EXCLUSIVE MODE');

      // Step 1: Recover exact destination coordinates from authoritative id_mappings (Requirement 1)
      const coordRecoveryQuery = `
        WITH recovered_coords AS (
          UPDATE record_manifests rm
          SET destination_object = im.destination_object,
              destination_key = im.destination_key
          FROM id_mappings im
          WHERE (rm.destination_object IS NULL OR rm.destination_key IS NULL)
            AND rm.migration_run_id = im.migration_run_id
            AND rm.source_object = im.source_object
            AND rm.source_key = im.source_key
            ${migrationRunId ? 'AND rm.migration_run_id = $1' : ''}
          RETURNING rm.id
        )
        SELECT COUNT(*)::int as count FROM recovered_coords;
      `;
      const coordRecovRes = await client.query(coordRecoveryQuery, migrationRunId ? [migrationRunId] : []);
      const resolvedCoordinatesCount = coordRecovRes.rows[0]?.count || 0;

      // Step 2: Archive unresolved incomplete legacy coordinates
      const archiveUnresolvedCoordsQuery = `
        WITH archived_unresolved_coords AS (
          INSERT INTO record_manifest_historical_archive (
            original_manifest_id, migration_run_id, migration_batch_id, batch_key,
            source_object, source_key, destination_object, destination_key,
            content_hash, status, error_details, reconciliation_reason, original_created_at
          )
          SELECT 
            id, migration_run_id, migration_batch_id, batch_key,
            source_object, source_key, destination_object, destination_key,
            content_hash, status, error_details, 'UNRESOLVED_INCOMPLETE_LEGACY_COORDINATES', created_at
          FROM record_manifests
          WHERE (destination_object IS NULL OR destination_key IS NULL)
            ${migrationRunId ? 'AND migration_run_id = $1' : ''}
          RETURNING original_manifest_id
        )
        DELETE FROM record_manifests
        WHERE id IN (SELECT original_manifest_id FROM archived_unresolved_coords)
        RETURNING id;
      `;
      const archiveUnresolvedCoordsRes = await client.query(
        archiveUnresolvedCoordsQuery,
        migrationRunId ? [migrationRunId] : [],
      );
      const unresolvedCoordinatesArchived = archiveUnresolvedCoordsRes.rows.length;

      // Step 3: Handle legacy batch relationships (Requirement 3)
      // Backfill batch_key if missing
      await client.query(
        `UPDATE record_manifests rm
         SET batch_key = mb.batch_key
         FROM migration_batches mb
         WHERE rm.batch_key IS NULL
           AND rm.migration_batch_id IS NOT NULL
           AND rm.migration_batch_id = mb.id
           AND rm.migration_run_id = mb.migration_run_id
           ${migrationRunId ? 'AND rm.migration_run_id = $1' : ''}`,
        migrationRunId ? [migrationRunId] : [],
      );

      // Backfill migration_batch_id if missing
      await client.query(
        `UPDATE record_manifests rm
         SET migration_batch_id = mb.id
         FROM migration_batches mb
         WHERE rm.migration_batch_id IS NULL
           AND rm.batch_key IS NOT NULL
           AND rm.migration_run_id = mb.migration_run_id
           AND rm.batch_key = mb.batch_key
           ${migrationRunId ? 'AND rm.migration_run_id = $1' : ''}`,
        migrationRunId ? [migrationRunId] : [],
      );

      // Archive genuinely unresolvable batch relationships
      const archiveUnresolvedBatchQuery = `
        WITH archived_unresolved_batch AS (
          INSERT INTO record_manifest_historical_archive (
            original_manifest_id, migration_run_id, migration_batch_id, batch_key,
            source_object, source_key, destination_object, destination_key,
            content_hash, status, error_details, reconciliation_reason, original_created_at
          )
          SELECT 
            rm.id, rm.migration_run_id, rm.migration_batch_id, rm.batch_key,
            rm.source_object, rm.source_key, rm.destination_object, rm.destination_key,
            rm.content_hash, rm.status, rm.error_details, 'UNRESOLVED_INCOMPLETE_LEGACY_BATCH_RELATION', rm.created_at
          FROM record_manifests rm
          WHERE (rm.migration_batch_id IS NULL 
             OR rm.batch_key IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM migration_batches mb
               WHERE mb.id = rm.migration_batch_id
                 AND mb.migration_run_id = rm.migration_run_id
                 AND mb.batch_key = rm.batch_key
             ))
             ${migrationRunId ? 'AND rm.migration_run_id = $1' : ''}
          RETURNING original_manifest_id
        )
        DELETE FROM record_manifests
        WHERE id IN (SELECT original_manifest_id FROM archived_unresolved_batch)
        RETURNING id;
      `;
      const archiveUnresolvedBatchRes = await client.query(
        archiveUnresolvedBatchQuery,
        migrationRunId ? [migrationRunId] : [],
      );
      const unresolvedBatchArchived = archiveUnresolvedBatchRes.rows.length;

      // Step 4: Detect existing duplicate identities
      let findDupsQuery = `
        SELECT migration_run_id, source_object, source_key, COUNT(*) as dup_count
        FROM record_manifests
      `;
      const queryParams: any[] = [];
      if (migrationRunId) {
        findDupsQuery += ` WHERE migration_run_id = $1`;
        queryParams.push(migrationRunId);
      }
      findDupsQuery += `
        GROUP BY migration_run_id, source_object, source_key
        HAVING COUNT(*) > 1
      `;

      const dupsRes = await client.query(findDupsQuery, queryParams);
      const distinctIdentitiesAffected = dupsRes.rows.length;
      let totalDuplicates = 0;
      let duplicateArchivedCount = 0;
      let archivedDetails: any[] = [];

      if (distinctIdentitiesAffected > 0) {
        totalDuplicates = dupsRes.rows.reduce(
          (acc: number, row: any) => acc + (parseInt(row.dup_count, 10) - 1),
          0,
        );

        // Archive superseded duplicates into record_manifest_historical_archive
        const archiveQuery = `
          WITH ranked_manifests AS (
            SELECT 
              rm.*,
              ROW_NUMBER() OVER (
                PARTITION BY migration_run_id, source_object, source_key
                ORDER BY 
                  CASE status WHEN 'WRITTEN' THEN 1 WHEN 'SKIPPED' THEN 2 ELSE 3 END,
                  created_at DESC,
                  id DESC
              ) as rank_order
            FROM record_manifests rm
            WHERE (migration_run_id, source_object, source_key) IN (
              SELECT migration_run_id, source_object, source_key
              FROM record_manifests
              ${migrationRunId ? 'WHERE migration_run_id = $1' : ''}
              GROUP BY migration_run_id, source_object, source_key
              HAVING COUNT(*) > 1
            )
          ),
          archived_rows AS (
            INSERT INTO record_manifest_historical_archive (
              original_manifest_id, migration_run_id, migration_batch_id, batch_key,
              source_object, source_key, destination_object, destination_key,
              content_hash, status, error_details, reconciliation_reason, original_created_at
            )
            SELECT 
              id, migration_run_id, migration_batch_id, batch_key,
              source_object, source_key, destination_object, destination_key,
              content_hash, status, error_details, 'DUPLICATE_SUPERSEDED_HISTORICAL_EVIDENCE', created_at
            FROM ranked_manifests
            WHERE rank_order > 1
            RETURNING original_manifest_id, migration_run_id, source_object, source_key
          )
          DELETE FROM record_manifests
          WHERE id IN (SELECT original_manifest_id FROM archived_rows)
          RETURNING id, migration_run_id, source_object, source_key;
        `;

        const archiveRes = await client.query(archiveQuery, queryParams);
        duplicateArchivedCount = archiveRes.rows.length;
        archivedDetails = archiveRes.rows;
      }

      const totalArchived = duplicateArchivedCount + unresolvedCoordinatesArchived + unresolvedBatchArchived;

      let reportId: string | undefined;
      if (totalArchived > 0 || resolvedCoordinatesCount > 0) {
        // Record explicit reconciliation report in manifest_reconciliation_reports
        const reportRes = await client.query(
          `INSERT INTO manifest_reconciliation_reports (
             migration_run_id, total_duplicates_detected, distinct_identities_affected,
             archived_record_count, reconciliation_policy, report_json, status
           ) VALUES ($1, $2, $3, $4, 'PRESERVE_LATEST_AND_ARCHIVE_SUPERSEDED', $5, 'COMPLETED')
           RETURNING id`,
          [
            migrationRunId || null,
            totalDuplicates,
            distinctIdentitiesAffected,
            totalArchived,
            JSON.stringify({
              timestamp: new Date().toISOString(),
              distinctIdentitiesCount: distinctIdentitiesAffected,
              duplicatesArchived: duplicateArchivedCount,
              resolvedCoordinatesCount,
              unresolvedCoordinatesArchived,
              unresolvedBatchArchived,
              reconciledRecords: archivedDetails,
              policy: 'PRESERVE_LATEST_AND_ARCHIVE_SUPERSEDED',
            }),
          ],
        );
        reportId = reportRes.rows[0]?.id;
      }

      return {
        duplicatesDetected: totalDuplicates,
        distinctIdentitiesAffected,
        archivedCount: totalArchived,
        resolvedCoordinatesCount,
        unresolvedCoordinatesArchived,
        unresolvedBatchArchived,
        reportId,
        details: archivedDetails,
      };
    });
  }

  private static readonly FORBIDDEN_READONLY_KEYWORDS = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'DROP',
    'CREATE',
    'ALTER',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'VACUUM',
    'ANALYZE',
    'ANALYSE',
    'CALL',
    'DO',
    'EXECUTE',
    'PREPARE',
    'DEALLOCATE',
    'COPY',
    'LOCK',
    'INTO',
    'RETURNING',
    'NOTIFY',
    'LISTEN',
    'UNLISTEN',
  ]);

  private static readonly ALLOWED_CLAUSE_KEYWORDS_BEFORE_PAREN = new Set([
    'SELECT',
    'FROM',
    'JOIN',
    'WHERE',
    'HAVING',
    'ON',
    'USING',
    'IN',
    'NOT',
    'AND',
    'OR',
    'EXISTS',
    'ANY',
    'ALL',
    'SOME',
    'VALUES',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'AS',
    'OVER',
    'FILTER',
    'WITHIN',
    'PARTITION',
    'ORDER',
    'GROUP',
    'BY',
    'ROW',
    'ARRAY',
    'UNION',
    'INTERSECT',
    'EXCEPT',
    'DISTINCT',
    'CROSS',
    'LEFT',
    'RIGHT',
    'INNER',
    'OUTER',
    'FULL',
    'NATURAL',
    'LATERAL',
    'GROUPING',
    'ROLLUP',
    'CUBE',
    'SETS',
    // SQL data type precision keywords (e.g. CAST(x AS VARCHAR(255)), x::NUMERIC(10, 2))
    'VARCHAR',
    'CHAR',
    'CHARACTER',
    'VARYING',
    'NUMERIC',
    'DECIMAL',
    'BIT',
    'VARBIT',
    'TIME',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'INTERVAL',
  ]);

  private static readonly SAFE_PURE_SQL_FUNCTIONS = new Set([
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'COALESCE',
    'NULLIF',
    'GREATEST',
    'LEAST',
    'LOWER',
    'UPPER',
    'TRIM',
    'BTRIM',
    'LTRIM',
    'RTRIM',
    'LENGTH',
    'CHAR_LENGTH',
    'CHARACTER_LENGTH',
    'SUBSTRING',
    'SUBSTR',
    'CONCAT',
    'CONCAT_WS',
    'SPLIT_PART',
    'REPLACE',
    'NOW',
    'CURRENT_TIMESTAMP',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'VERSION',
    'CURRENT_DATABASE',
    'CURRENT_SCHEMA',
    'CAST',
    'EXTRACT',
    'DATE_TRUNC',
    'TO_CHAR',
    'TO_TIMESTAMP',
    'JSON_BUILD_OBJECT',
    'JSONB_BUILD_OBJECT',
    'JSON_AGG',
    'JSONB_AGG',
    'JSON_TYPEOF',
    'JSONB_TYPEOF',
    'ARRAY_AGG',
    'ROW_NUMBER',
    'RANK',
    'DENSE_RANK',
    'ABS',
    'ROUND',
    'FLOOR',
    'CEIL',
    'CEILING',
  ]);

  /**
   * Minimal PostgreSQL-aware SQL tokenizer for retry-safety evaluation.
   * Strips line comments and nested block comments; handles single-quoted,
   * backslash-escaped (E'...'), dollar-quoted ($tag$...$tag$), and double-quoted tokens.
   * Returns null (fail-closed) on any unclosed string, identifier, or block comment.
   */
  private static tokenizeSql(
    sql: string,
  ): Array<{ type: 'WORD' | 'QUOTED_IDENT' | 'STRING' | 'NUMBER' | 'PARAM' | 'PUNCT' | 'OP'; value: string; upper: string }> | null {
    const tokens: Array<{
      type: 'WORD' | 'QUOTED_IDENT' | 'STRING' | 'NUMBER' | 'PARAM' | 'PUNCT' | 'OP';
      value: string;
      upper: string;
    }> = [];
    const n = sql.length;
    let i = 0;

    while (i < n) {
      const ch = sql[i];

      // 1. Skip whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // 2. Skip line comments (-- ...)
      if (ch === '-' && sql[i + 1] === '-') {
        i += 2;
        while (i < n && sql[i] !== '\n') i++;
        continue;
      }

      // 3. Skip nested block comments (/* ... */)
      if (ch === '/' && sql[i + 1] === '*') {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (sql[i] === '*' && sql[i + 1] === '/') {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        if (depth > 0) return null; // Unclosed comment
        continue;
      }

      // 4. Escaped / Prefixed string literals (E'...', B'...', X'...', N'...')
      if ((ch === 'E' || ch === 'e' || ch === 'N' || ch === 'n' || ch === 'B' || ch === 'b' || ch === 'X' || ch === 'x') && sql[i + 1] === "'") {
        const allowBackslash = ch === 'E' || ch === 'e';
        let start = i;
        i += 2;
        let closed = false;
        while (i < n) {
          if (allowBackslash && sql[i] === '\\') {
            i += 2;
            continue;
          }
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return null;
        const val = sql.slice(start, i);
        tokens.push({ type: 'STRING', value: val, upper: val.toUpperCase() });
        continue;
      }

      // 5. Standard single-quoted string literal ('...')
      if (ch === "'") {
        let start = i;
        i++;
        let closed = false;
        while (i < n) {
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return null;
        const val = sql.slice(start, i);
        tokens.push({ type: 'STRING', value: val, upper: val.toUpperCase() });
        continue;
      }

      // 6. Double-quoted identifier ("...")
      if (ch === '"') {
        let start = i;
        i++;
        let closed = false;
        while (i < n) {
          if (sql[i] === '"') {
            if (sql[i + 1] === '"') {
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return null;
        const val = sql.slice(start, i);
        tokens.push({ type: 'QUOTED_IDENT', value: val, upper: val.toUpperCase() });
        continue;
      }

      // 7. Dollar-quoted string ($tag$...$tag$) OR positional param ($1)
      if (ch === '$') {
        const paramMatch = /^\$[0-9]+/.exec(sql.slice(i));
        if (paramMatch) {
          tokens.push({ type: 'PARAM', value: paramMatch[0], upper: paramMatch[0] });
          i += paramMatch[0].length;
          continue;
        }
        const tagMatch = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
        if (tagMatch) {
          const delimiter = tagMatch[0];
          const closeIdx = sql.indexOf(delimiter, i + delimiter.length);
          if (closeIdx === -1) return null; // Unclosed dollar-quoted string
          const endIdx = closeIdx + delimiter.length;
          const val = sql.slice(i, endIdx);
          tokens.push({ type: 'STRING', value: val, upper: val.toUpperCase() });
          i = endIdx;
          continue;
        }
      }

      // 8. Numbers
      if (/[0-9]/.test(ch)) {
        const numMatch = /^[0-9]+(?:\.[0-9]+)?/.exec(sql.slice(i));
        if (numMatch) {
          tokens.push({ type: 'NUMBER', value: numMatch[0], upper: numMatch[0] });
          i += numMatch[0].length;
          continue;
        }
      }

      // 9. Words (unquoted keywords or identifiers)
      if (/[a-zA-Z_]/.test(ch)) {
        const wordMatch = /^[a-zA-Z_][a-zA-Z0-9_$]*/.exec(sql.slice(i));
        if (wordMatch) {
          const val = wordMatch[0];
          tokens.push({ type: 'WORD', value: val, upper: val.toUpperCase() });
          i += val.length;
          continue;
        }
      }

      // 10. Structural punctuation
      if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.') {
        tokens.push({ type: 'PUNCT', value: ch, upper: ch });
        i++;
        continue;
      }

      // 11. Multi-char and single-char operators (::, <>, !=, <=, >=, ||, etc.)
      const opMatch = /^(?:::|<>|!=|<=|>=|\|\||->>|->|#>>|#>|[=<>+\-*/%!~&|^@#?:])/.exec(sql.slice(i));
      if (opMatch) {
        tokens.push({ type: 'OP', value: opMatch[0], upper: opMatch[0] });
        i += opMatch[0].length;
        continue;
      }

      // Fail closed on unrecognized character
      return null;
    }

    return tokens;
  }

  /**
   * Evaluates whether a SQL statement passes our strict read-only SQL-lexer & pure-function
   * allowlist policy, failing closed on any unrecognized constructs or potential side effects.
   *
   * Policy (fail-closed):
   * - Single statement only (rejects multi-statement queries).
   * - Must begin with SELECT (rejects WITH CTEs, EXPLAIN/EXPLAIN ANALYZE, SET, SHOW, CALL, DO, DDL, DML).
   * - Disallows mutating/locking keywords (INSERT, UPDATE, DELETE, INTO, FOR UPDATE/SHARE, etc.).
   * - Rejects quoted-identifier function calls ("fn"()) and schema-qualified calls (schema.fn()).
   * - Rejects ANY unrecognized function call not present in SAFE_PURE_SQL_FUNCTIONS
   *   (blocking pg_notify, set_config, nextval, setval, pg_advisory_lock, and arbitrary custom functions).
   */
  public static isSafeRetryableReadQuery(sql: string): boolean {
    if (!sql || typeof sql !== 'string' || !sql.trim()) return false;

    const tokens = DatabaseService.tokenizeSql(sql);
    if (!tokens || tokens.length === 0) return false;

    // Strip a single optional trailing semicolon
    if (tokens[tokens.length - 1].type === 'PUNCT' && tokens[tokens.length - 1].value === ';') {
      tokens.pop();
    }
    if (tokens.length === 0) return false;

    // Reject any internal semicolons (multi-statement queries)
    if (tokens.some((t) => t.type === 'PUNCT' && t.value === ';')) {
      return false;
    }

    // Must start with unquoted SELECT
    if (tokens[0].type !== 'WORD' || tokens[0].upper !== 'SELECT') {
      return false;
    }

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      const prev = tokens[i - 1];

      if (tok.type === 'WORD') {
        if (DatabaseService.FORBIDDEN_READONLY_KEYWORDS.has(tok.upper)) {
          return false;
        }

        // Reject FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE
        if (tok.upper === 'FOR' && next?.type === 'WORD') {
          if (
            next.upper === 'UPDATE' ||
            next.upper === 'SHARE' ||
            next.upper === 'KEY' ||
            next.upper === 'NO'
          ) {
            return false;
          }
        }
      }

      // Inspect any call-like construct followed by '('
      if (next && next.type === 'PUNCT' && next.value === '(') {
        if (tok.type === 'QUOTED_IDENT') {
          return false; // Reject quoted function calls like "pg_notify"(...)
        }

        if (tok.type === 'WORD') {
          // Reject any schema-qualified function call like public.fn(...) or pg_catalog.set_config(...)
          if (prev && prev.type === 'PUNCT' && prev.value === '.') {
            return false;
          }

          if (
            !DatabaseService.ALLOWED_CLAUSE_KEYWORDS_BEFORE_PAREN.has(tok.upper) &&
            !DatabaseService.SAFE_PURE_SQL_FUNCTIONS.has(tok.upper)
          ) {
            return false;
          }
        }
      }
    }

    return true;
  }

  private isIdempotentQuery(sql: string): boolean {
    return DatabaseService.isSafeRetryableReadQuery(sql);
  }

  /**
   * Executes a parameterized SQL query.
   * If PostgreSQL is connected, executes directly on PostgreSQL.
   * SQL errors from PostgreSQL are NEVER swallowed or silently redirected to memory.
   */
  async query<T extends pg.QueryResultRow = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
    if (this.isConnected && this.pool) {
      let attempts = 0;
      const maxAttempts = 3;
      const canRetry = this.isIdempotentQuery(text);

      while (attempts < maxAttempts) {
        attempts++;
        try {
          const res = await this.pool.query<T>(text, params);
          return {
            rows: res.rows,
            rowCount: res.rowCount ?? res.rows.length,
          };
        } catch (err: any) {
          const isTransient =
            err.code === 'ECONNRESET' ||
            err.code === 'ENOTFOUND' ||
            err.code === 'EAI_AGAIN' ||
            err.code === 'ETIMEDOUT' ||
            err.message?.includes('ECONNRESET') ||
            err.message?.includes('ENOTFOUND') ||
            err.message?.includes('Connection terminated') ||
            err.message?.includes('closed unexpectedly');

          if (isTransient && canRetry && attempts < maxAttempts) {
            const backoffMs = Math.min(200 * Math.pow(2, attempts - 1) + Math.floor(Math.random() * 100), 2000);
            console.warn(
              `[DatabaseService] Transient database socket error on idempotent query (${err.message}), retrying (attempt ${attempts}/${maxAttempts}) in ${backoffMs}ms...`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          throw err;
        }
      }
    }

    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_IN_MEMORY_DB !== 'true') {
      throw new Error(
        '[DatabaseService] Cannot execute query: PostgreSQL is not connected. In-memory store is strictly forbidden in production.',
      );
    }

    if (process.env.ALLOW_IN_MEMORY_DB === 'true' || process.env.NODE_ENV === 'test') {
      return this.queryMemory<T>(text, params);
    }

    throw new Error(
      '[DatabaseService] Cannot execute query: PostgreSQL is not connected and in-memory store is disabled.',
    );
  }

  /**
   * Execute operations within a PostgreSQL transaction
   */
  async transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.isConnected || !this.pool) {
      throw new Error('[DatabaseService] Transactions require an active PostgreSQL connection.');
    }
    const client = await this.pool.connect();
    try {
      if (this.customSearchPath) {
        await client.query(`SET search_path TO ${this.customSearchPath}`);
      }
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public get searchPath(): string | undefined {
    return this.customSearchPath;
  }

  public getRawPool(): pg.Pool | null {
    return this.pool;
  }

  /**
   * Memory store query simulator supporting standard CRUD (used only when ALLOW_IN_MEMORY_DB=true)
   */
  private queryMemory<T extends pg.QueryResultRow = any>(text: string, params: any[] = []): QueryResult<T> {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('INSERT INTO')) {
      return this.handleMemoryInsert<T>(trimmed, params);
    }

    if (upper.startsWith('SELECT')) {
      return this.handleMemorySelect<T>(trimmed, params);
    }

    if (upper.startsWith('UPDATE')) {
      return this.handleMemoryUpdate<T>(trimmed, params);
    }

    if (upper.startsWith('DELETE FROM')) {
      return this.handleMemoryDelete<T>(trimmed, params);
    }

    return { rows: [], rowCount: 0 };
  }

  private handleMemoryInsert<T>(sql: string, params: any[]): QueryResult<T> {
    const insertMatch = /INSERT\s+INTO\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\(([\s\S]*?)\)\s*VALUES\s*\(/i.exec(sql);
    if (!insertMatch) return { rows: [], rowCount: 0 };

    const tableName = insertMatch[1].toLowerCase();
    const columns = insertMatch[2].split(',').map((c) => c.trim().toLowerCase());
    const valuesStartIndex = insertMatch.index + insertMatch[0].length;
    
    // Balanced parentheses extraction for VALUES (...)
    let depth = 1;
    let valuesEndIndex = -1;
    let inQuotes = false;
    for (let i = valuesStartIndex; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'" && sql[i - 1] !== '\\') {
        inQuotes = !inQuotes;
      } else if (!inQuotes) {
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            valuesEndIndex = i;
            break;
          }
        }
      }
    }
    const valuesPart = valuesEndIndex !== -1 ? sql.slice(valuesStartIndex, valuesEndIndex) : sql.slice(valuesStartIndex);
    const rawValues = this.splitSqlCsv(valuesPart);

    const table = this.memoryStore.get(tableName);
    if (!table) {
      this.memoryStore.set(tableName, new Map());
    }
    const currentTable = this.memoryStore.get(tableName)!;

    const row: Record<string, any> = {};
    columns.forEach((col, idx) => {
      const valToken = (rawValues[idx] || '').trim();
      if (valToken.startsWith('$')) {
        const pIdx = parseInt(valToken.slice(1), 10) - 1;
        row[col] = params[pIdx];
      } else if (valToken === 'NOW()' || valToken.toUpperCase() === 'CURRENT_TIMESTAMP') {
        row[col] = new Date().toISOString();
      } else if (valToken === 'gen_random_uuid()') {
        row[col] = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
      } else if (valToken.startsWith("'") && valToken.endsWith("'")) {
        row[col] = valToken.slice(1, -1);
      } else if (!isNaN(Number(valToken)) && valToken !== '') {
        row[col] = Number(valToken);
      } else if (valToken.toUpperCase() === 'NULL') {
        row[col] = null;
      } else {
        row[col] = valToken;
      }
    });

    if (!row.id) {
      row.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    }
    if (!row.created_at) row.created_at = new Date().toISOString();
    if (!row.updated_at) row.updated_at = new Date().toISOString();

    currentTable.set(row.id, row);

    return { rows: [row as unknown as T], rowCount: 1 };
  }

  private splitSqlCsv(str: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let depth = 0;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "'" && str[i - 1] !== '\\') {
        inQuotes = !inQuotes;
        current += ch;
      } else if ((ch === '(' || ch === '{') && !inQuotes) {
        depth++;
        current += ch;
      } else if ((ch === ')' || ch === '}') && !inQuotes) {
        depth--;
        current += ch;
      } else if (ch === ',' && !inQuotes && depth === 0) {
        tokens.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim().length > 0) {
      tokens.push(current.trim());
    }
    return tokens;
  }

  private handleMemorySelect<T>(sql: string, params: any[]): QueryResult<T> {
    const fromMatch = /FROM\s+["`]?([a-zA-Z0-9_]+)["`]?/i.exec(sql);
    if (!fromMatch) return { rows: [], rowCount: 0 };

    const tableName = fromMatch[1].toLowerCase();
    const table = this.memoryStore.get(tableName);
    if (!table) {
      if (/SELECT\s+COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?/i.test(sql)) {
        const countMatch = /SELECT\s+COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?/i.exec(sql);
        const alias = countMatch && countMatch[1] ? countMatch[1].toLowerCase() : 'count';
        const countRow: Record<string, any> = {};
        countRow[alias] = '0';
        return { rows: [countRow as unknown as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    let results = Array.from(table.values()).map((r) => ({ ...r }));

    // If query has JOIN workspace_members wm, enrich rows with workspace_members info
    if (/JOIN\s+workspace_members\s+/i.test(sql)) {
      const wmTable = this.memoryStore.get('workspace_members');
      if (wmTable) {
        const enriched: any[] = [];
        for (const r of results) {
          const members = Array.from(wmTable.values()).filter(
            (wm: any) => wm.user_id === (r.id || r.user_id),
          );
          for (const wm of members) {
            enriched.push({
              ...r,
              workspace_id: wm.workspace_id,
              member_role: wm.role,
              role: wm.role,
            });
          }
        }
        results = enriched;
      }
    }

    // If query has JOIN users u, enrich rows with user info
    if (/JOIN\s+users\s+/i.test(sql)) {
      const usersTable = this.memoryStore.get('users');
      if (usersTable) {
        results = results.map((r) => {
          const userId = r.user_id || r.actor_id || r.approver_user_id || r.created_by;
          if (userId && usersTable.has(userId)) {
            const u = usersTable.get(userId);
            return {
              ...r,
              email: u.email,
              name: u.name,
              actor_email: u.email,
              actor_name: u.name,
              approver_email: u.email,
              approver_name: u.name,
            };
          }
          return r;
        });
      }
    }

    // If query has JOIN migration_runs mr, enrich rows with run info
    if (/JOIN\s+migration_runs\s+/i.test(sql)) {
      const runsTable = this.memoryStore.get('migration_runs');
      if (runsTable) {
        results = results.map((r) => {
          const runId = r.migration_run_id || r.run_id || r.id;
          if (runId && runsTable.has(runId)) {
            const run = runsTable.get(runId);
            return {
              ...r,
              workspace_id: run.workspace_id,
              project_id: run.project_id,
              plan_version_id: run.plan_version_id,
            };
          }
          return r;
        });
      }
    }

    // If query has JOIN migration_plans mp, enrich rows with plan info
    if (/JOIN\s+migration_plans\s+/i.test(sql)) {
      const plansTable = this.memoryStore.get('migration_plans');
      if (plansTable) {
        results = results.map((r) => {
          const planId = r.plan_id || r.id;
          if (planId && plansTable.has(planId)) {
            const p = plansTable.get(planId);
            return {
              ...r,
              workspace_id: p.workspace_id,
              project_id: p.project_id,
              plan_name: p.name,
            };
          }
          return r;
        });
      }
    }

    // If query has JOIN workspaces w, enrich rows with workspace info
    if (/JOIN\s+workspaces\s+/i.test(sql)) {
      const wsTable = this.memoryStore.get('workspaces');
      if (wsTable) {
        results = results.map((r) => {
          const wsId = r.workspace_id;
          if (wsId && wsTable.has(wsId)) {
            const w = wsTable.get(wsId);
            return {
              ...r,
              workspace_name: w.name,
              workspace_slug: w.slug,
            };
          }
          return r;
        });
      }
    }

    // Basic WHERE filter parser
    const whereMatch = /WHERE\s+([\s\S]*?)(?:ORDER BY|LIMIT|$)/i.exec(sql);
    if (whereMatch) {
      const whereClause = whereMatch[1].trim();
      const conditions = whereClause.split(/\s+AND\s+/i);

      for (const cond of conditions) {
        const paramMatch = /(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i.exec(cond);
        if (paramMatch) {
          const col = paramMatch[1].toLowerCase();
          const paramIdx = parseInt(paramMatch[2], 10) - 1;
          const targetVal = params[paramIdx];
          results = results.filter((r) => r[col] === targetVal);
          continue;
        }

        const literalMatch = /(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*=\s*'([^']+)'/i.exec(cond);
        if (literalMatch) {
          const col = literalMatch[1].toLowerCase();
          const targetVal = literalMatch[2];
          results = results.filter((r) => r[col] === targetVal);
          continue;
        }

        const inMatch = /(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s+IN\s*\(([^)]+)\)/i.exec(cond);
        if (inMatch) {
          const col = inMatch[1].toLowerCase();
          const allowedVals = inMatch[2]
            .split(',')
            .map((v) => v.trim().replace(/^'|'$/g, ''));
          results = results.filter((r) => allowedVals.includes(r[col]));
          continue;
        }
      }
    }

    // Check for COUNT(*) aggregate query
    if (/SELECT\s+COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?/i.test(sql)) {
      const countMatch = /SELECT\s+COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?/i.exec(sql);
      const alias = countMatch && countMatch[1] ? countMatch[1].toLowerCase() : 'count';
      const countRow: Record<string, any> = {};
      countRow[alias] = String(results.length);
      return { rows: [countRow as unknown as T], rowCount: 1 };
    }

    // ORDER BY
    const orderMatch = /ORDER BY\s+(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*(DESC|ASC)?/i.exec(sql);
    if (orderMatch) {
      const col = orderMatch[1].toLowerCase();
      const desc = (orderMatch[2] || 'ASC').toUpperCase() === 'DESC';
      results.sort((a, b) => {
        if (a[col] < b[col]) return desc ? 1 : -1;
        if (a[col] > b[col]) return desc ? -1 : 1;
        return 0;
      });
    }

    // OFFSET
    const offsetMatch = /OFFSET\s+(\d+|\$\d+)/i.exec(sql);
    if (offsetMatch) {
      let offset = 0;
      if (offsetMatch[1].startsWith('$')) {
        const idx = parseInt(offsetMatch[1].slice(1), 10) - 1;
        offset = parseInt(params[idx], 10);
      } else {
        offset = parseInt(offsetMatch[1], 10);
      }
      results = results.slice(offset);
    }

    // LIMIT
    const limitMatch = /LIMIT\s+(\d+|\$\d+)/i.exec(sql);
    if (limitMatch) {
      let limit = 100;
      if (limitMatch[1].startsWith('$')) {
        const idx = parseInt(limitMatch[1].slice(1), 10) - 1;
        limit = parseInt(params[idx], 10);
      } else {
        limit = parseInt(limitMatch[1], 10);
      }
      results = results.slice(0, limit);
    }

    return { rows: results as unknown as T[], rowCount: results.length };
  }

  private handleMemoryUpdate<T>(sql: string, params: any[]): QueryResult<T> {
    const tableMatch = /UPDATE\s+["`]?([a-zA-Z0-9_]+)["`]?/i.exec(sql);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1].toLowerCase();
    const table = this.memoryStore.get(tableName);
    if (!table) return { rows: [], rowCount: 0 };

    const setMatch = /SET\s+([\s\S]*?)\s+WHERE/i.exec(sql);
    const whereMatch = /WHERE\s+([\s\S]*?)(?:RETURNING|$)/i.exec(sql);
    if (!setMatch || !whereMatch) return { rows: [], rowCount: 0 };

    const setPairs = this.splitSqlCsv(setMatch[1]);
    const whereCond = whereMatch[1].trim();

    const targetMatch = /(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i.exec(whereCond);
    if (!targetMatch) return { rows: [], rowCount: 0 };

    const whereCol = targetMatch[1].toLowerCase();
    const whereParamIdx = parseInt(targetMatch[2], 10) - 1;
    const targetVal = params[whereParamIdx];

    const updatedRows: any[] = [];
    for (const [id, row] of table.entries()) {
      if (row[whereCol] === targetVal) {
        for (const pair of setPairs) {
          const colParam = /([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i.exec(pair);
          if (colParam) {
            const col = colParam[1].toLowerCase();
            const pIdx = parseInt(colParam[2], 10) - 1;
            row[col] = params[pIdx];
          } else {
            const colInc = /([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\s*\+\s*(\d+)/i.exec(pair);
            if (colInc) {
              const col = colInc[1].toLowerCase();
              const baseCol = colInc[2].toLowerCase();
              const incVal = parseInt(colInc[3], 10);
              row[col] = (Number(row[baseCol]) || 0) + incVal;
            } else {
              const colLiteral = /([a-zA-Z0-9_]+)\s*=\s*'([^']+)'/i.exec(pair);
              if (colLiteral) {
                row[colLiteral[1].toLowerCase()] = colLiteral[2];
              } else {
                const colNow = /([a-zA-Z0-9_]+)\s*=\s*NOW\(\)/i.exec(pair);
                if (colNow) {
                  row[colNow[1].toLowerCase()] = new Date().toISOString();
                }
              }
            }
          }
        }
        row.updated_at = new Date().toISOString();
        table.set(id, row);
        updatedRows.push(row);
      }
    }

    return { rows: updatedRows as unknown as T[], rowCount: updatedRows.length };
  }

  private handleMemoryDelete<T>(sql: string, params: any[]): QueryResult<T> {
    const match = /DELETE\s+FROM\s+["`]?([a-zA-Z0-9_]+)["`]?\s+WHERE\s+(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i.exec(sql);
    if (!match) return { rows: [], rowCount: 0 };

    const tableName = match[1].toLowerCase();
    const whereCol = match[2].toLowerCase();
    const paramIdx = parseInt(match[3], 10) - 1;
    const targetVal = params[paramIdx];

    const table = this.memoryStore.get(tableName);
    if (!table) return { rows: [], rowCount: 0 };

    let deletedCount = 0;
    for (const [id, row] of table.entries()) {
      if (row[whereCol] === targetVal) {
        table.delete(id);
        deletedCount++;
      }
    }

    return { rows: deletedCount as unknown as any, rowCount: deletedCount };
  }
}
