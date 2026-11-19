import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoConnector, type MongoDriverAdapter, type MongoCollectionAdapter } from '../dist/connectors/mongodb/mongo-connector.js';

describe('MongoDB Source Connector (Mock Fixtures)', () => {
  function createMockDriver(options?: { failPing?: boolean }): MongoDriverAdapter {
    const mockDocs = [
      { _id: 'doc_1', name: 'Alpha', score: 10 },
      { _id: 'doc_2', name: 'Beta', score: 20 },
      { _id: 'doc_3', name: 'Gamma', score: 30 },
      { _id: 'doc_4', name: 'Delta', score: 40 },
      { _id: 'doc_5', name: 'Epsilon', score: 50 },
    ];

    const collections: Record<string, MongoCollectionAdapter> = {
      items: {
        name: 'items',
        countDocuments: async () => mockDocs.length,
        find: async (filter = {}, findOpts = {}) => {
          let filtered = [...mockDocs];
          if (filter._id && typeof filter._id === 'object' && (filter._id as { $gt?: string }).$gt) {
            const gtId = (filter._id as { $gt: string }).$gt;
            filtered = filtered.filter((d) => d._id > gtId);
          }
          if (findOpts.limit) {
            filtered = filtered.slice(0, findOpts.limit);
          }
          return filtered;
        },
        indexes: async () => [
          { name: '_id_', key: { _id: 1 }, unique: true },
        ],
      },
    };

    return {
      ping: async () => {
        if (options?.failPing) {
          throw new Error('ECONNREFUSED 127.0.0.1:27017');
        }
        return { ok: 1, version: '7.0.5' };
      },
      listCollections: async () => Object.keys(collections),
      collection: (name: string) => collections[name],
      close: async () => {},
    };
  }

  it('testConnection: should report healthy when ping succeeds', async () => {
    const driver = createMockDriver();
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    const res = await connector.testConnection();
    assert.equal(res.healthy, true);
    assert.equal(res.serverVersion, '7.0.5');
    assert.ok(res.latencyMs >= 0);
    assert.ok(res.capabilities.canStream);
  });

  it('testConnection: should catch connection errors and throw classified ConnectorError', async () => {
    const driver = createMockDriver({ failPing: true });
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    await assert.rejects(async () => {
      await connector.testConnection();
    }, (err: any) => {
      assert.equal(err.code, 'CONNECTION_FAILED');
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('discoverSchema: should inspect collections and sample documents', async () => {
    const driver = createMockDriver();
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    const snapshot = await connector.discoverSchema();
    assert.equal(snapshot.engine, 'MONGODB');
    assert.equal(snapshot.objects.length, 1);
    assert.equal(snapshot.objects[0].name, 'items');
    assert.ok(snapshot.objects[0].fields.some((f) => f.name === 'name'));
  });

  it('profile: should profile collection data types and nullability', async () => {
    const driver = createMockDriver();
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    const prof = await connector.profile({ objects: ['items'] });
    assert.equal(prof.objectProfiles.length, 1);
    assert.equal(prof.objectProfiles[0].objectName, 'items');
    assert.ok(prof.objectProfiles[0].fields['score']);
    assert.equal(prof.objectProfiles[0].fields['score'].min, 10);
    assert.equal(prof.objectProfiles[0].fields['score'].max, 50);
  });

  it('readBatch: should paginate bounded batches using _id cursors', async () => {
    const driver = createMockDriver();
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    // Page 1: batch size 2
    const page1 = await connector.readBatch(undefined, {
      objectName: 'items',
      batchSize: 2,
    });

    assert.equal(page1.records.length, 2);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.records[0].sourceKey, 'doc_1');
    assert.equal(page1.records[1].sourceKey, 'doc_2');
    assert.equal(page1.nextCursor?.lastId, 'doc_2');

    // Page 2: with cursor from page 1
    const page2 = await connector.readBatch(page1.nextCursor, {
      objectName: 'items',
      batchSize: 2,
    });

    assert.equal(page2.records.length, 2);
    assert.equal(page2.hasMore, true);
    assert.equal(page2.records[0].sourceKey, 'doc_3');
    assert.equal(page2.records[1].sourceKey, 'doc_4');

    // Page 3: final record
    const page3 = await connector.readBatch(page2.nextCursor, {
      objectName: 'items',
      batchSize: 2,
    });

    assert.equal(page3.records.length, 1);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.records[0].sourceKey, 'doc_5');
  });

  it('count: should return document count', async () => {
    const driver = createMockDriver();
    const connector = new MongoConnector({
      config: { host: 'localhost', port: 27017, database: 'testdb' },
      driver,
    });

    const cnt = await connector.count('items');
    assert.equal(cnt, 5);
  });
});
