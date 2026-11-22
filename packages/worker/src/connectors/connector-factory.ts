import pg from 'pg';
import { MongoClient, ObjectId } from 'mongodb';
import {
  DestinationConnector,
  SourceConnector,
  TransformedBatch,
  WriteOptions,
  WriteResult,
  DestinationRecord,
  SourceCursor,
  SourceBatch,
  ReadBatchOptions,
} from '../types.js';

export function quoteIdent(name: string): string {
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`[Security] Invalid SQL identifier: '${name}'. Must be alphanumeric and underscore only.`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function normalizeIpHost(host: string): string {
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

export const isLoopbackHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
};

export const isUnspecifiedHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
  return normalized === '0.0.0.0' || normalized === '::';
};

export const isUnsafeProductionHost = (host: string): boolean => {
  return isLoopbackHost(host) || isUnspecifiedHost(host);
};

export const resolvePostgresSsl = (connectionString: string): boolean | { rejectUnauthorized: boolean } => {
  let isLocal = false;
  let hostname = '';
  try {
    const parsed = new URL(connectionString);
    hostname = parsed.hostname;
    isLocal = isLoopbackHost(hostname);
  } catch {
    const match = /@(?:\[([^\]]+)\]|([^/@]+?)(?::\d+)?(?:\/|$))/.exec(connectionString);
    if (match) {
      hostname = match[1] || match[2];
      isLocal = isLoopbackHost(hostname);
    }
  }

  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true';
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && isUnsafeProductionHost(hostname)) {
    throw new Error(
      `[Security] In production (NODE_ENV=production), PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses (${hostname}).`,
    );
  }

  if (isLocal && !isProduction) {
    return false;
  }
  return { rejectUnauthorized: !allowInsecureTls };
};

export class PostgresDestinationConnector implements DestinationConnector {
  private pool: pg.Pool;

  constructor(poolOrConnectionString: pg.Pool | string) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = new pg.Pool({
        connectionString: poolOrConnectionString,
        connectionTimeoutMillis: 10000,
        max: 10,
        ssl: resolvePostgresSsl(poolOrConnectionString),
      });
    } else {
      this.pool = poolOrConnectionString;
    }
  }

  async query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async testConnection(): Promise<{ success: boolean; latencyMs: number; message?: string }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return {
        success: true,
        latencyMs: Date.now() - start,
        message: 'PostgreSQL connection verified',
      };
    } catch (err: any) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        message: err.message,
      };
    }
  }

  async writeBatch(batch: TransformedBatch, options: WriteOptions): Promise<WriteResult> {
    const start = Date.now();
    const tableName = batch.destinationObject;
    const records = batch.records;

    if (!records || records.length === 0) {
      return {
        recordsWritten: 0,
        recordsSkipped: 0,
        recordsFailed: 0,
        writtenKeys: [],
        skippedKeys: [],
        failedKeys: [],
        durationMs: 0,
      };
    }

    const writtenKeys: string[] = [];
    const skippedKeys: string[] = [];
    const failedKeys: Array<{ key: string; error: string; code?: string }> = [];

    const CHUNK_SIZE = 25;
    for (let idx = 0; idx < records.length; idx += CHUNK_SIZE) {
      const chunk = records.slice(idx, idx + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (rec) => {
          const data = rec.data || {};
          const cols = Object.keys(data);
          if (cols.length === 0) return;

          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const colNames = cols.map((c) => quoteIdent(c)).join(', ');
          const values = cols.map((c) => data[c]);
          const quotedTable = quoteIdent(tableName);

          let sql = `INSERT INTO ${quotedTable} (${colNames}) VALUES (${placeholders})`;

          const conflictCols = options.conflictColumns && options.conflictColumns.length > 0
            ? options.conflictColumns
            : ['id'];
          const conflictTarget = conflictCols.map((c) => quoteIdent(c)).join(', ');

          if (options.writeMode === 'upsert') {
            const updateCols = options.updateColumns || cols.filter((c) => !conflictCols.includes(c));
            if (updateCols.length > 0) {
              const updateAssignments = updateCols
                .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
                .join(', ');
              sql += ` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateAssignments}`;
            } else {
              sql += ` ON CONFLICT (${conflictTarget}) DO NOTHING`;
            }
          } else if (options.writeMode === 'skip_existing') {
            sql += ` ON CONFLICT (${conflictTarget}) DO NOTHING`;
          }
          // 'insert_only' has no ON CONFLICT clause

          try {
            const res = await this.pool.query(sql, values);
            if (res.rowCount && res.rowCount > 0) {
              writtenKeys.push(rec.destinationKey);
            } else {
              skippedKeys.push(rec.destinationKey);
            }
          } catch (err: any) {
            failedKeys.push({
              key: rec.destinationKey,
              error: err.message,
              code: err.code,
            });
          }
        }),
      );
    }

    return {
      recordsWritten: writtenKeys.length,
      recordsSkipped: skippedKeys.length,
      recordsFailed: failedKeys.length,
      writtenKeys,
      skippedKeys,
      failedKeys,
      durationMs: Date.now() - start,
    };
  }

  async readByKeys(destinationObject: string, keys: string[]): Promise<DestinationRecord[]> {
    if (!keys || keys.length === 0) return [];

    const quotedTable = quoteIdent(destinationObject);
    const res = await this.pool.query(
      `SELECT * FROM ${quotedTable} WHERE "id" = ANY($1)`,
      [keys],
    );

    return res.rows.map((row: any) => ({
      destinationKey: String(row.id),
      data: row,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class MongoSourceConnector implements SourceConnector {
  private client: MongoClient;
  private dbName: string;

  constructor(connectionString: string, dbName = 'migrationguard_test') {
    this.client = new MongoClient(connectionString, { connectTimeoutMS: 10000 });
    this.dbName = dbName;
  }

  async testConnection(): Promise<{ success: boolean; latencyMs: number; message?: string }> {
    const start = Date.now();
    try {
      await this.client.db(this.dbName).command({ ping: 1 });
      return {
        success: true,
        latencyMs: Date.now() - start,
        message: 'MongoDB connection verified',
      };
    } catch (err: any) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        message: err.message,
      };
    }
  }

  async readBatch(cursor: SourceCursor | null, options: ReadBatchOptions): Promise<SourceBatch> {
    const coll = this.client.db(this.dbName).collection(options.sourceObject);
    const filter: Record<string, unknown> = {};

    if (cursor?.lastId !== undefined && cursor?.lastId !== null) {
      const lastIdStr = String(cursor.lastId);
      if (/^[0-9a-fA-F]{24}$/.test(lastIdStr)) {
        try {
          filter._id = { $gt: new ObjectId(lastIdStr) };
        } catch {
          filter._id = { $gt: cursor.lastId };
        }
      } else {
        filter._id = { $gt: cursor.lastId };
      }
    }

    const limit = options.batchSize || 1000;
    let findQuery = coll.find(filter).sort({ _id: 1 });
    if (cursor?.offset !== undefined && cursor.offset > 0 && !cursor.lastId) {
      findQuery = findQuery.skip(cursor.offset);
    }
    const docs = await findQuery.limit(limit + 1).toArray();

    const hasMore = docs.length > limit;
    const batchDocs = hasMore ? docs.slice(0, limit) : docs;

    const records = batchDocs.map((doc) => {
      const id = String(doc._id);
      return {
        sourceObject: options.sourceObject,
        sourceKey: id,
        sourceCursor: { lastId: id },
        payload: doc,
        extractedAt: new Date().toISOString(),
      };
    });

    const lastRecord = records[records.length - 1];
    const nextCursor: SourceCursor | null = hasMore && lastRecord
      ? { lastId: lastRecord.sourceKey }
      : null;

    return {
      records,
      nextCursor,
      hasMore,
      stats: {
        recordsCount: records.length,
      },
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class ConnectorFactory {
  public static createPostgresDestination(
    connectionStringOrPool: string | pg.Pool,
  ): DestinationConnector {
    return new PostgresDestinationConnector(connectionStringOrPool);
  }

  public static createMongoSource(
    connectionString: string,
    dbName = 'migrationguard_test',
  ): SourceConnector {
    return new MongoSourceConnector(connectionString, dbName);
  }
}
