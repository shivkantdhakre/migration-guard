import {
  DestinationConnector,
  ConnectionTestResult,
  DiscoveryOptions,
  WriteOptions,
  WriteResult,
  StableKey,
  DestinationRecord,
  ConnectorError,
} from '../contract.js';
import {
  DatabaseEngine,
  SchemaSnapshot,
  TransformedBatch,
  PostgresConnectionConfig,
  ObjectSchema,
  FieldSchema,
  ConstraintDefinition,
  IndexDefinition,
} from '../../types/index.js';
import { createSchemaSnapshot } from '../../discovery/schema-discovery.js';
import { buildBatchInsertQuery, quoteTableName, quoteIdent } from './query-builder.js';

export interface PostgresQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface PostgresDriverAdapter {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PostgresQueryResult<R>>;
  close(): Promise<void>;
}

/**
 * PostgreSQL Destination Connector
 */
export class PostgresConnector implements DestinationConnector {
  public readonly engine: DatabaseEngine = 'POSTGRESQL';
  private config: PostgresConnectionConfig;
  private driver: PostgresDriverAdapter;
  private connectionId: string;
  private workspaceId: string;

  constructor(params: {
    connectionId?: string;
    workspaceId?: string;
    config: PostgresConnectionConfig;
    driver: PostgresDriverAdapter;
  }) {
    this.connectionId = params.connectionId || 'conn-pg-default';
    this.workspaceId = params.workspaceId || 'ws-default';
    this.config = params.config;
    this.driver = params.driver;
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const res = await this.driver.query('SELECT version();');
      const latencyMs = Date.now() - startTime;
      const versionStr = res.rows.length > 0 ? String(Object.values(res.rows[0])[0]) : 'PostgreSQL';

      return {
        healthy: true,
        message: 'Successfully connected to PostgreSQL',
        latencyMs,
        serverVersion: versionStr,
        capabilities: {
          canStream: true,
          supportsTransactions: true,
          supportsTls: Boolean(this.config.ssl),
          supportedTypes: ['text', 'integer', 'bigint', 'numeric', 'timestamp', 'jsonb', 'uuid', 'boolean'],
        },
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      throw new ConnectorError({
        message: `Failed to connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async inspectSchema(options?: DiscoveryOptions): Promise<SchemaSnapshot> {
    const startTime = Date.now();
    const targetSchema = this.config.schema || 'public';

    try {
      // 1. Query tables and views
      const tableQuery = `
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name;
      `;
      const tableRes = await this.driver.query<{ table_name: string; table_type: string }>(tableQuery, [targetSchema]);

      const objectSchemas: ObjectSchema[] = [];

      for (const row of tableRes.rows) {
        const tableName = row.table_name;
        if (options?.objects && options.objects.length > 0 && !options.objects.includes(tableName)) {
          continue;
        }

        // 2. Query columns
        const colQuery = `
          SELECT column_name, data_type, udt_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position;
        `;
        const colRes = await this.driver.query<{
          column_name: string;
          data_type: string;
          udt_name: string;
          is_nullable: string;
          column_default: unknown;
        }>(colQuery, [targetSchema, tableName]);

        // 3. Query primary keys
        const pkQuery = `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2;
        `;
        const pkRes = await this.driver.query<{ column_name: string }>(pkQuery, [targetSchema, tableName]);
        const pkCols = new Set(pkRes.rows.map((r) => r.column_name));

        const fields: FieldSchema[] = colRes.rows.map((c) => ({
          name: c.column_name,
          path: c.column_name,
          dataType: c.data_type,
          nativeType: c.udt_name,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: pkCols.has(c.column_name),
          defaultValue: c.column_default ?? undefined,
        }));

        const constraints: ConstraintDefinition[] = [];
        if (pkCols.size > 0) {
          constraints.push({
            name: `pk_${tableName}`,
            type: 'PRIMARY_KEY',
            columns: Array.from(pkCols),
          });
        }

        objectSchemas.push({
          name: tableName,
          schema: targetSchema,
          type: row.table_type === 'VIEW' ? 'VIEW' : 'TABLE',
          fields,
          constraints,
        });
      }

      return createSchemaSnapshot({
        id: `snap-pg-${Date.now()}`,
        workspaceId: this.workspaceId,
        connectionId: this.connectionId,
        connectionVersion: 1,
        schemaVersion: 1,
        engine: 'POSTGRESQL',
        objects: objectSchemas,
        samplingMethod: 'FULL',
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      throw new ConnectorError({
        message: `PostgreSQL schema inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async writeBatch(batch: TransformedBatch, options: WriteOptions): Promise<WriteResult> {
    const startTime = Date.now();
    let recordsWritten = 0;
    let recordsUpdated = 0;
    let recordsSkipped = 0;
    let recordsFailed = 0;
    const errors: Array<{ key: string; error: string; retryable: boolean }> = [];

    if (!batch.records || batch.records.length === 0) {
      return {
        recordsWritten: 0,
        recordsUpdated: 0,
        recordsSkipped: 0,
        recordsFailed: 0,
        durationMs: 0,
      };
    }

    // Group records by destination table
    const tableGroups = new Map<string, Array<{ key: string; payload: Record<string, unknown> }>>();
    for (const rec of batch.records) {
      const tbl = rec.destinationObject;
      if (!tableGroups.has(tbl)) {
        tableGroups.set(tbl, []);
      }
      tableGroups.get(tbl)!.push({ key: rec.destinationKey, payload: rec.payload });
    }

    const defaultSchema = this.config.schema || 'public';

    for (const [tableName, records] of tableGroups) {
      try {
        const query = buildBatchInsertQuery({
          tableName,
          defaultSchema,
          records: records.map((r) => r.payload),
          mode: options.mode,
          conflictColumns: options.conflictColumns,
          updateColumns: options.updateColumns,
        });

        const res = await this.driver.query(query.text, query.values);
        const count = res.rowCount ?? records.length;

        if (options.mode === 'UPSERT') {
          recordsWritten += count;
          recordsUpdated += Math.max(0, records.length - count);
        } else if (options.mode === 'SKIP_EXISTING') {
          recordsWritten += count;
          recordsSkipped += Math.max(0, records.length - count);
        } else {
          recordsWritten += count;
        }
      } catch (err) {
        recordsFailed += records.length;
        const msg = err instanceof Error ? err.message : String(err);
        const isConstraint = /unique constraint|foreign key constraint|not-null constraint/i.test(msg);
        errors.push({
          key: tableName,
          error: msg,
          retryable: !isConstraint,
        });

        throw new ConnectorError({
          message: `writeBatch failed on table "${tableName}": ${msg}`,
          code: isConstraint ? 'CONSTRAINT_VIOLATION' : 'CONNECTION_FAILED',
          retryable: !isConstraint,
          cause: err,
        });
      }
    }

    // Process child rows if any exist
    if (batch.childBatches) {
      for (const [childTable, childRows] of Object.entries(batch.childBatches)) {
        if (childRows.length > 0) {
          const query = buildBatchInsertQuery({
            tableName: childTable,
            defaultSchema,
            records: childRows.map((r) => r.payload),
            mode: options.mode,
            conflictColumns: options.conflictColumns,
            updateColumns: options.updateColumns,
          });
          await this.driver.query(query.text, query.values);
        }
      }
    }

    return {
      recordsWritten,
      recordsUpdated,
      recordsSkipped,
      recordsFailed,
      durationMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  public async readByKeys(objectName: string, keys: StableKey[]): Promise<DestinationRecord[]> {
    if (keys.length === 0) return [];

    const defaultSchema = this.config.schema || 'public';
    const quotedTable = quoteTableName(objectName, defaultSchema);
    const keyCol = keys[0].key;
    const quotedKeyCol = quoteIdent(keyCol);

    const values = keys.map((k) => k.value);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `SELECT * FROM ${quotedTable} WHERE ${quotedKeyCol} IN (${placeholders});`;

    try {
      const res = await this.driver.query(sql, values);
      const rowsByKey = new Map<string, Record<string, unknown>>();

      for (const row of res.rows) {
        const rowKeyVal = String(row[keyCol]);
        rowsByKey.set(rowKeyVal, row);
      }

      return keys.map((k) => {
        const strKey = String(k.value);
        const foundRow = rowsByKey.get(strKey);
        return {
          destinationKey: strKey,
          data: foundRow || {},
          found: Boolean(foundRow),
        };
      });
    } catch (err) {
      throw new ConnectorError({
        message: `readByKeys failed on "${objectName}": ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async count(objectName: string): Promise<number> {
    const defaultSchema = this.config.schema || 'public';
    const quotedTable = quoteTableName(objectName, defaultSchema);
    try {
      const res = await this.driver.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quotedTable};`);
      return parseInt(res.rows[0].count, 10);
    } catch (err) {
      throw new ConnectorError({
        message: `Count failed on "${objectName}": ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async close(): Promise<void> {
    await this.driver.close();
  }
}
