import pg from 'pg';
import { MongoClient } from 'mongodb';
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

export class PostgresDestinationConnector implements DestinationConnector {
  private pool: pg.Pool;

  constructor(poolOrConnectionString: pg.Pool | string) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = new pg.Pool({
        connectionString: poolOrConnectionString,
        connectionTimeoutMillis: 10000,
        max: 10,
      });
    } else {
      this.pool = poolOrConnectionString;
    }
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

    for (const rec of records) {
      const data = rec.data || {};
      const cols = Object.keys(data);
      if (cols.length === 0) continue;

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const colNames = cols.map((c) => `"${c}"`).join(', ');
      const values = cols.map((c) => data[c]);

      let sql = `INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`;

      if (options.writeMode === 'upsert') {
        const updateCols = options.updateColumns || cols.filter((c) => c !== 'id');
        if (updateCols.length > 0) {
          const updateAssignments = updateCols
            .map((c) => `"${c}" = EXCLUDED."${c}"`)
            .join(', ');
          sql += ` ON CONFLICT ("id") DO UPDATE SET ${updateAssignments}`;
        } else {
          sql += ` ON CONFLICT ("id") DO NOTHING`;
        }
      } else if (options.writeMode === 'skip_existing') {
        sql += ` ON CONFLICT ("id") DO NOTHING`;
      }

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

    const res = await this.pool.query(
      `SELECT * FROM "${destinationObject}" WHERE "id" = ANY($1)`,
      [keys],
    );

    const map = new Map<string, Record<string, unknown>>();
    for (const row of res.rows) {
      map.set(String(row.id), row);
    }

    return keys.map((k) => ({
      destinationKey: k,
      data: map.get(k) || {},
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
      filter._id = { $gt: cursor.lastId };
    }

    const limit = options.batchSize || 1000;
    const docs = await coll
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

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
