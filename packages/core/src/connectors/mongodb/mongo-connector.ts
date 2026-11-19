import {
  SourceConnector,
  ConnectionTestResult,
  DiscoveryOptions,
  ReadBatchOptions,
  SourceBatch,
  ConnectorError,
} from '../contract.js';
import {
  DatabaseEngine,
  SchemaSnapshot,
  ProfileOptions,
  ProfileResult,
  SourceCursor,
  SourceRecordEnvelope,
  MongoConnectionConfig,
} from '../../types/index.js';
import { buildMongoCollectionSchema, createSchemaSnapshot } from '../../discovery/schema-discovery.js';
import { profileRecords, createProfileResult } from '../../profiling/profiler.js';
import { normalizeBsonValue } from '../../transforms/operations.js';

export interface MongoCollectionAdapter {
  name: string;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  find(
    filter?: Record<string, unknown>,
    options?: {
      limit?: number;
      skip?: number;
      sort?: Record<string, 1 | -1>;
      projection?: Record<string, 1 | 0>;
    }
  ): Promise<Array<Record<string, unknown>>>;
  indexes?(): Promise<Array<{ name: string; key: Record<string, 1 | -1>; unique?: boolean }>>;
}

export interface MongoDriverAdapter {
  ping(): Promise<{ ok: number; version?: string }>;
  listCollections(): Promise<string[]>;
  collection(name: string): MongoCollectionAdapter;
  close(): Promise<void>;
}

/**
 * MongoDB Source Connector
 */
export class MongoConnector implements SourceConnector {
  public readonly engine: DatabaseEngine = 'MONGODB';
  private config: MongoConnectionConfig;
  private driver: MongoDriverAdapter;
  private connectionId: string;
  private workspaceId: string;

  constructor(params: {
    connectionId?: string;
    workspaceId?: string;
    config: MongoConnectionConfig;
    driver: MongoDriverAdapter;
  }) {
    this.connectionId = params.connectionId || 'conn-mongo-default';
    this.workspaceId = params.workspaceId || 'ws-default';
    this.config = params.config;
    this.driver = params.driver;
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const res = await this.driver.ping();
      const latencyMs = Date.now() - startTime;
      if (!res || res.ok !== 1) {
        return {
          healthy: false,
          message: 'MongoDB ping command did not return ok=1',
          latencyMs,
          serverVersion: res?.version,
          capabilities: {
            canStream: true,
            supportsTransactions: true,
            supportsTls: Boolean(this.config.tls),
            supportedTypes: ['ObjectId', 'Decimal128', 'Date', 'Binary', 'Array', 'Object'],
          },
          testedAt: new Date().toISOString(),
        };
      }

      return {
        healthy: true,
        message: 'Successfully connected to MongoDB',
        latencyMs,
        serverVersion: res.version || 'unknown',
        capabilities: {
          canStream: true,
          supportsTransactions: true,
          supportsTls: Boolean(this.config.tls),
          supportedTypes: ['ObjectId', 'Decimal128', 'Date', 'Binary', 'Array', 'Object'],
        },
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      throw new ConnectorError({
        message: `Failed to connect to MongoDB: ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async discoverSchema(options?: DiscoveryOptions): Promise<SchemaSnapshot> {
    const startTime = Date.now();
    try {
      const allCollections = await this.driver.listCollections();
      const targetCollections = options?.objects && options.objects.length > 0
        ? allCollections.filter((c) => options.objects!.includes(c))
        : allCollections;

      const sampleSize = options?.sampleSize || 100;
      const objectSchemas = [];

      for (const collName of targetCollections) {
        const coll = this.driver.collection(collName);
        const docs = await coll.find({}, { limit: sampleSize, sort: { _id: 1 } });

        const rawIndexes = coll.indexes ? await coll.indexes() : [];
        const indexDefs = rawIndexes.map((idx) => ({
          name: idx.name,
          columns: Object.keys(idx.key),
          isUnique: Boolean(idx.unique),
          isPrimary: idx.name === '_id_',
        }));

        const schema = buildMongoCollectionSchema(collName, docs, indexDefs);
        objectSchemas.push(schema);
      }

      return createSchemaSnapshot({
        id: `snap-${Date.now()}`,
        workspaceId: this.workspaceId,
        connectionId: this.connectionId,
        connectionVersion: 1,
        schemaVersion: 1,
        engine: 'MONGODB',
        objects: objectSchemas,
        samplingMethod: 'BOUNDED_SAMPLE',
        sampleSize,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      throw new ConnectorError({
        message: `Schema discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async profile(options: ProfileOptions): Promise<ProfileResult> {
    const startTime = Date.now();
    try {
      const allCollections = await this.driver.listCollections();
      const targetCollections = options.objects && options.objects.length > 0
        ? allCollections.filter((c) => options.objects!.includes(c))
        : allCollections;

      const sampleSize = options.sampleSize || 200;
      const objectProfiles = [];

      for (const collName of targetCollections) {
        const coll = this.driver.collection(collName);
        const docs = await coll.find({}, { limit: sampleSize, sort: { _id: 1 } });
        const prof = profileRecords(collName, docs, options);
        objectProfiles.push(prof);
      }

      return createProfileResult(
        `prof-${Date.now()}`,
        this.connectionId,
        objectProfiles,
        Date.now() - startTime
      );
    } catch (err) {
      throw new ConnectorError({
        message: `Profiling failed: ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async readBatch(cursor?: SourceCursor, options?: ReadBatchOptions): Promise<SourceBatch> {
    if (!options?.objectName) {
      throw new ConnectorError({
        message: 'readBatch requires objectName (collection name)',
        code: 'SCHEMA_MISMATCH',
        retryable: false,
      });
    }

    const collName = options.objectName;
    const batchSize = options.batchSize || 500;
    const coll = this.driver.collection(collName);

    // Build filter with cursor
    const filter: Record<string, unknown> = { ...(options.filter || {}) };
    if (cursor?.lastId !== undefined && cursor?.lastId !== null) {
      filter._id = { $gt: cursor.lastId };
    }

    try {
      // Query one extra document to determine if there are more
      const docs = await coll.find(filter, {
        limit: batchSize + 1,
        sort: { _id: 1 },
      });

      const hasMore = docs.length > batchSize;
      const batchDocs = hasMore ? docs.slice(0, batchSize) : docs;

      let bytesRead = 0;
      const records: SourceRecordEnvelope[] = [];

      let lastId: unknown = cursor?.lastId;

      for (const doc of batchDocs) {
        const normalized = normalizeBsonValue(doc) as Record<string, unknown>;
        const docJson = JSON.stringify(normalized);
        const docBytes = Buffer.byteLength(docJson, 'utf8');
        bytesRead += docBytes;

        const rawId = doc._id;
        let sourceKey = 'unknown';
        if (rawId !== undefined && rawId !== null) {
          if (typeof rawId === 'object' && typeof (rawId as { toHexString?: () => string }).toHexString === 'function') {
            sourceKey = (rawId as { toHexString: () => string }).toHexString();
          } else {
            sourceKey = String(rawId);
          }
          lastId = rawId;
        }

        records.push({
          sourceObject: collName,
          sourceKey,
          sourceCursor: {
            lastId,
            isExhausted: !hasMore,
          },
          payload: normalized,
          extractedAt: new Date().toISOString(),
        });
      }

      const nextCursor: SourceCursor = {
        lastId,
        isExhausted: !hasMore,
        recordsReadSoFar: (cursor?.recordsReadSoFar || 0) + records.length,
      };

      const batchKey = `batch_${collName}_${Date.now()}_${records.length}`;

      return {
        batchKey,
        records,
        nextCursor,
        hasMore,
        bytesRead,
      };
    } catch (err) {
      throw new ConnectorError({
        message: `readBatch failed on collection "${collName}": ${err instanceof Error ? err.message : String(err)}`,
        code: 'CONNECTION_FAILED',
        retryable: true,
        cause: err,
      });
    }
  }

  public async count(objectName: string, filter?: Record<string, unknown>): Promise<number> {
    try {
      const coll = this.driver.collection(objectName);
      return await coll.countDocuments(filter);
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
