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
        max: 10,
        ssl,
      };
      if (this.customSearchPath) {
        poolConfig.options = `-c search_path=${this.customSearchPath}`;
      }
      this.pool = new pg.Pool(poolConfig);

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

  private static migrationsRan = false;

  public async runMigrations() {
    if (!this.isConnected || !this.pool) return;
    if (DatabaseService.migrationsRan) return;
    const client = await this.pool.connect();
    try {
      if (this.customSearchPath) {
        await client.query(`SET search_path TO ${this.customSearchPath}`);
      }
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['migrationguard_schema_migrations']);
      try {
        if (DatabaseService.migrationsRan) return;
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
          DatabaseService.migrationsRan = true;
          console.log('[DatabaseService] Migrations executed successfully.');
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['migrationguard_schema_migrations']).catch(() => {});
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

  /**
   * Executes a parameterized SQL query.
   * If PostgreSQL is connected, executes directly on PostgreSQL.
   * SQL errors from PostgreSQL are NEVER swallowed or silently redirected to memory.
   */
  async query<T extends pg.QueryResultRow = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
    if (this.isConnected && this.pool) {
      const res = await this.pool.query<T>(text, params);
      return {
        rows: res.rows,
        rowCount: res.rowCount ?? res.rows.length,
      };
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
      await client.query('ROLLBACK');
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
    if (!table) return { rows: [], rowCount: 0 };

    let results = Array.from(table.values()).map((r) => ({ ...r }));

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
