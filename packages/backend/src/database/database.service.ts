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

  // In-memory relational store fallback for unit testing or explicitly enabled offline dev
  private memoryStore: Map<string, Map<string, any>> = new Map();

  async onModuleInit() {
    this.initMemoryTables();
    const isInMemoryAllowed = process.env.ALLOW_IN_MEMORY_DB === 'true';

    try {
      this.pool = new pg.Pool({
        connectionString: appConfig.databaseUrl,
        connectionTimeoutMillis: 10000,
        max: 10,
      });

      const client = await this.pool.connect();
      client.release();
      this.isConnected = true;
      console.log('[DatabaseService] Connected to PostgreSQL successfully.');
      await this.runMigrations();
    } catch (err: any) {
      this.isConnected = false;
      if (process.env.NODE_ENV === 'production' || !isInMemoryAllowed) {
        console.error(`[DatabaseService] CRITICAL: Failed to connect to mandatory PostgreSQL (${err.message}).`);
        // If in-memory is not explicitly permitted, throw fatal error
        if (!isInMemoryAllowed) {
          throw new Error(
            `[DatabaseService] Database connection failed and in-memory fallback is disabled: ${err.message}`,
          );
        }
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
    try {
      const sqlPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await this.pool.query(sql);
        console.log('[DatabaseService] Migrations executed successfully.');
      }
    } catch (err: any) {
      console.error('[DatabaseService] Migration failed:', err.message);
      throw err;
    }
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
    const match = /INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i.exec(sql);
    if (!match) return { rows: [], rowCount: 0 };

    const tableName = match[1].toLowerCase();
    const columns = match[2].split(',').map((c) => c.trim().toLowerCase());
    const rawValues = this.splitSqlCsv(match[3]);

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
    const fromMatch = /FROM\s+([a-zA-Z0-9_]+)/i.exec(sql);
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
    const tableMatch = /UPDATE\s+([a-zA-Z0-9_]+)/i.exec(sql);
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
        row.updated_at = new Date().toISOString();
        table.set(id, row);
        updatedRows.push(row);
      }
    }

    return { rows: updatedRows as unknown as T[], rowCount: updatedRows.length };
  }

  private handleMemoryDelete<T>(sql: string, params: any[]): QueryResult<T> {
    const match = /DELETE\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*=\s*\$(\d+)/i.exec(sql);
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
