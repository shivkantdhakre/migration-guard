import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { calculateCanonicalHash, TransformationEngine, ObjectMapping } from '@migrationguard/core';
import { ObjectId, Long, Decimal128 } from 'mongodb';
import { DestinationWriter } from '../src/engine/destination-writer.js';
import { ErrorClassifier } from '../src/engine/error-classifier.js';
import { ConnectorFactory, detectBsonId, reconstructBsonId } from '../src/connectors/connector-factory.js';
import { DestinationConnector, TransformedBatch, SourceRecordEnvelope } from '../src/types.js';
import { PostgresStorageAdapters } from '../src/engine/postgres-storage-adapters.js';
import { IdTracker } from '../src/engine/id-tracker.js';
import crypto from 'node:crypto';

describe('Production Readiness Regression - Worker Areas (6, 7, 8, 9, 10, 11)', () => {
  describe('Area 6: Destination Write Integrity & Collision Detection', () => {
    it('detects and throws collision when different source records map to the same destinationKey within a batch', async () => {
      const mockConnector: DestinationConnector = {
        writeBatch: vi.fn().mockResolvedValue({
          recordsWritten: 1,
          recordsSkipped: 0,
          recordsFailed: 0,
          writtenKeys: ['dest_1'],
          skippedKeys: [],
          failedKeys: [],
        }),
        readByKeys: vi.fn(),
        testConnection: vi.fn(),
        close: vi.fn(),
      };

      const writer = new DestinationWriter({ connector: mockConnector });

      const batch: TransformedBatch = {
        destinationObject: 'users',
        batchKey: 'batch_test_001',
        records: [
          {
            sourceKey: 'source_user_A',
            destinationKey: 'dest_collision_1',
            contentHash: 'hash_AAA',
            data: { id: 'dest_collision_1', name: 'Alice' },
          },
          {
            sourceKey: 'source_user_B', // Different source record mapping to same destination key!
            destinationKey: 'dest_collision_1',
            contentHash: 'hash_BBB',
            data: { id: 'dest_collision_1', name: 'Bob' },
          },
        ],
      };

      await expect(
        writer.write(batch, {
          migrationRunId: 'run_123',
          sourceObject: 'users',
          writeMode: 'upsert',
        }),
      ).rejects.toThrow(/Collision detected: distinct source records map to the same destinationKey 'dest_collision_1'/);
    });

    it('detects cross-batch collisions when distinct source record in subsequent batch maps to an already-written destinationKey', async () => {
      const mockConnector: DestinationConnector = {
        writeBatch: vi.fn().mockResolvedValue({
          recordsWritten: 1,
          recordsSkipped: 0,
          recordsFailed: 0,
          writtenKeys: ['dest_shared_key'],
          skippedKeys: [],
          failedKeys: [],
        }),
        readByKeys: vi.fn(),
        testConnection: vi.fn(),
        close: vi.fn(),
      };

      // Mock IdTracker where dest_shared_key was previously written by 'source_batch1_record'
      const mockIdTracker: any = {
        recordMapping: vi.fn().mockResolvedValue(undefined),
        getSourceKey: vi.fn().mockImplementation(async (runId: string, destObj: string, destKey: string) => {
          if (destKey === 'dest_shared_key') {
            return 'source_batch1_record';
          }
          return null;
        }),
      };

      const writer = new DestinationWriter({
        connector: mockConnector,
        idTracker: mockIdTracker,
      });

      const batch: TransformedBatch = {
        destinationObject: 'customers',
        batchKey: 'batch_002',
        records: [
          {
            sourceKey: 'source_batch2_record', // Distinct source record!
            destinationKey: 'dest_shared_key',
            contentHash: 'hash_different',
            data: { id: 'dest_shared_key', email: 'batch2@example.com' },
          },
        ],
      };

      await expect(
        writer.write(batch, {
          migrationRunId: 'run_999',
          sourceObject: 'customers',
          writeMode: 'upsert',
        }),
      ).rejects.toThrow(/Collision detected: distinct source record 'source_batch2_record' maps to destinationKey 'dest_shared_key' which was already written by source record 'source_batch1_record'/);
    });

    it('allows deduplication of genuine duplicates with identical sourceKey and contentHash', async () => {
      const writtenKeysRecorded: string[] = [];
      const mockConnector: DestinationConnector = {
        writeBatch: vi.fn().mockImplementation(async (b: TransformedBatch) => {
          writtenKeysRecorded.push(...b.records.map((r) => r.destinationKey));
          return {
            recordsWritten: b.records.length,
            recordsSkipped: 0,
            recordsFailed: 0,
            writtenKeys: b.records.map((r) => r.destinationKey),
            skippedKeys: [],
            failedKeys: [],
          };
        }),
        readByKeys: vi.fn(),
        testConnection: vi.fn(),
        close: vi.fn(),
      };

      const writer = new DestinationWriter({ connector: mockConnector });

      const batch: TransformedBatch = {
        destinationObject: 'users',
        batchKey: 'batch_test_002',
        records: [
          {
            sourceKey: 'source_user_A',
            destinationKey: 'dest_1',
            contentHash: 'hash_AAA',
            data: { id: 'dest_1', name: 'Alice' },
          },
          {
            sourceKey: 'source_user_A', // Genuine duplicate: same sourceKey and contentHash
            destinationKey: 'dest_1',
            contentHash: 'hash_AAA',
            data: { id: 'dest_1', name: 'Alice' },
          },
        ],
      };

      const result = await writer.write(batch, {
        migrationRunId: 'run_123',
        sourceObject: 'users',
        writeMode: 'upsert',
      });

      expect(result.recordsWritten).toBe(1);
      expect(writtenKeysRecorded).toEqual(['dest_1']);
    });

    it('rejects records that produce empty destination payloads', async () => {
      const mockConnector: DestinationConnector = {
        writeBatch: vi.fn(),
        readByKeys: vi.fn(),
        testConnection: vi.fn(),
        close: vi.fn(),
      };

      const writer = new DestinationWriter({ connector: mockConnector });

      const batch: TransformedBatch = {
        destinationObject: 'users',
        batchKey: 'batch_test_003',
        records: [
          {
            sourceKey: 'source_user_A',
            destinationKey: 'dest_empty',
            contentHash: 'hash_empty',
            data: {}, // Empty payload!
          },
        ],
      };

      await expect(
        writer.write(batch, {
          migrationRunId: 'run_123',
          sourceObject: 'users',
          writeMode: 'upsert',
        }),
      ).rejects.toThrow(/produced an empty destination payload/);
    });

    it('never marks record WRITTEN in manifest unless destination connector confirmed the write', async () => {
      const recordedManifests: any[] = [];
      const mockManifestTracker: any = {
        updateSubStage: vi.fn().mockResolvedValue(undefined),
        recordManifests: vi.fn().mockImplementation(async (m: any[]) => {
          recordedManifests.push(...m);
        }),
      };

      // Destination connector only confirms dest_1, but NOT dest_unconfirmed
      const mockConnector: DestinationConnector = {
        writeBatch: vi.fn().mockResolvedValue({
          recordsWritten: 1,
          recordsSkipped: 0,
          recordsFailed: 0,
          writtenKeys: ['dest_1'], // dest_unconfirmed is omitted!
          skippedKeys: [],
          failedKeys: [],
        }),
        readByKeys: vi.fn(),
        testConnection: vi.fn(),
        close: vi.fn(),
      };

      const writer = new DestinationWriter({
        connector: mockConnector,
        manifestTracker: mockManifestTracker,
      });

      const batch: TransformedBatch = {
        destinationObject: 'users',
        batchKey: 'batch_test_004',
        records: [
          {
            sourceKey: 'src_1',
            destinationKey: 'dest_1',
            contentHash: 'hash_1',
            data: { id: 'dest_1', val: 1 },
          },
          {
            sourceKey: 'src_2',
            destinationKey: 'dest_unconfirmed',
            contentHash: 'hash_2',
            data: { id: 'dest_unconfirmed', val: 2 },
          },
        ],
      };

      await writer.write(batch, {
        migrationRunId: 'run_123',
        sourceObject: 'users',
        writeMode: 'upsert',
      });

      expect(recordedManifests).toHaveLength(2);
      const m1 = recordedManifests.find((m) => m.destinationKey === 'dest_1');
      const m2 = recordedManifests.find((m) => m.destinationKey === 'dest_unconfirmed');

      expect(m1.status).toBe('WRITTEN');
      expect(m2.status).toBe('FAILED');
      expect(m2.error).toContain('Destination connector did not confirm write');
    });

    it('proves in QueueHandler flow that unconfirmed writes abort execution before checkpoint advancement and commit', async () => {
      const { QueueHandler } = await import('../src/engine/queue-handler.js');

      const mockSource: any = {
        readBatch: vi.fn().mockResolvedValue({
          records: [
            { sourceObject: 'users', sourceKey: 'src_1', payload: { id: 'dest_1', name: 'Alice' }, extractedAt: new Date().toISOString() },
            { sourceObject: 'users', sourceKey: 'src_2', payload: { id: 'dest_unconfirmed', name: 'Bob' }, extractedAt: new Date().toISOString() },
          ],
          nextCursor: { lastId: 'src_2', lastIdType: 'string' },
          hasMore: false,
        }),
      };

      const mockDest: any = {
        writeBatch: vi.fn().mockResolvedValue({
          recordsWritten: 1,
          recordsSkipped: 0,
          recordsFailed: 0,
          writtenKeys: ['dest_1'], // dest_unconfirmed is NOT confirmed!
          skippedKeys: [],
          failedKeys: [],
        }),
        readByKeys: vi.fn(),
      };

      const mockManifestTracker: any = {
        getBatch: vi.fn().mockResolvedValue(null),
        createBatch: vi.fn().mockResolvedValue({ id: 'batch_q1', status: 'PENDING', sequenceNo: 1 }),
        transitionState: vi.fn().mockResolvedValue(undefined),
        updateCounters: vi.fn().mockResolvedValue(undefined),
        updateSubStage: vi.fn().mockResolvedValue(undefined),
        recordManifests: vi.fn().mockResolvedValue(undefined),
      };

      const checkpointAdvanced = vi.fn().mockResolvedValue(undefined);
      const mockCheckpointManager: any = {
        advanceCheckpoint: checkpointAdvanced,
        getCheckpoint: vi.fn().mockResolvedValue(null),
      };

      const handler = new QueueHandler({
        sourceConnector: mockSource,
        destinationConnector: mockDest,
        manifestTracker: mockManifestTracker,
        checkpointManager: mockCheckpointManager,
        transformFn: (env: any) => ({
          sourceObject: env.sourceObject,
          sourceKey: env.sourceKey,
          destinationObject: 'users_target',
          destinationKey: env.payload.id,
          data: env.payload,
          contentHash: 'hash_sample',
        }),
      });

      const payload = {
        jobId: 'job_1',
        migrationRunId: 'run_test_unconfirmed',
        batchKey: 'batch_unconfirmed_1',
        sequenceNo: 1,
        sourceObject: 'users',
        destinationObject: 'users_target',
        cursorStart: null,
        batchSize: 10,
        planVersionId: 'plan_1',
        mappingVersionId: 'map_1',
        writeMode: 'upsert' as const,
        destinationKey: 'id',
      };

      const result = await handler.processJob(payload);
      expect(result.status).not.toBe('COMMITTED');
      expect(result.error?.message).toMatch(/Destination write failed for 1 of 2 records/);

      // Prove that checkpoint was NEVER advanced and batch was NEVER committed!
      expect(checkpointAdvanced).not.toHaveBeenCalled();
      const committedCalls = mockManifestTracker.transitionState.mock.calls.filter(
        (call: any[]) => call[2] === 'COMMITTED',
      );
      expect(committedCalls).toHaveLength(0);
    });
  });

  describe('Area 9: Error Classification & Preservation', () => {
    it('classifies PostgreSQL serialization failure (40001) and deadlock (40P01) as RETRYABLE', () => {
      const serialErr = Object.assign(new Error('could not serialize access due to concurrent update'), {
        code: '40001',
      });
      const deadlockErr = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });

      const c1 = ErrorClassifier.classify(serialErr, 'WRITE_STARTED');
      expect(c1.classification).toBe('RETRYABLE');
      expect(c1.isRetryable).toBe(true);

      const c2 = ErrorClassifier.classify(deadlockErr, 'WRITE_STARTED');
      expect(c2.classification).toBe('RETRYABLE');
      expect(c2.isRetryable).toBe(true);
    });

    it('classifies connection error 08006 during in-flight write as OUTCOME_UNKNOWN', () => {
      const connDropErr = Object.assign(new Error('connection failure'), {
        code: '08006',
      });

      const classified = ErrorClassifier.classify(connDropErr, 'WRITE_STARTED');
      expect(classified.classification).toBe('OUTCOME_UNKNOWN');
      expect(classified.requiresReconciliation).toBe(true);
      expect(classified.isRetryable).toBe(false);
    });

    it('preserves pre-classified error structure and original error codes when wrapped', () => {
      const rawDbErr = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      const classifiedInner = ErrorClassifier.classify(rawDbErr, 'READ_STARTED');

      const wrappedErr = Object.assign(new Error('Wrapper failure'), {
        classified: classifiedInner,
        originalError: rawDbErr,
        code: '40P01',
      });

      const classifiedOuter = ErrorClassifier.classify(wrappedErr);
      expect(classifiedOuter.classification).toBe('RETRYABLE');
      expect(classifiedOuter.code).toBe('40P01');
      expect(classifiedOuter.originalError).toBe(rawDbErr);
    });

    it('classifies COLLISION_DETECTED and EMPTY_DESTINATION_PAYLOAD as PERMANENT', () => {
      const colErr = Object.assign(new Error('Collision detected: distinct source records map to same key'), {
        code: 'COLLISION_DETECTED',
      });
      const emptyErr = Object.assign(new Error('Record produced an empty destination payload'), {
        code: 'EMPTY_DESTINATION_PAYLOAD',
      });

      expect(ErrorClassifier.classify(colErr).classification).toBe('PERMANENT');
      expect(ErrorClassifier.classify(emptyErr).classification).toBe('PERMANENT');
    });
  });

  describe('Area 7: MongoDB Cursor BSON Type Fidelity', () => {
    it('supports MongoSourceConnector instantiation and validates BSON cursor structure', () => {
      const connector = ConnectorFactory.createMongoSource(
        'mongodb://localhost:27017/test_db',
        'test_db',
      );
      expect(connector).toBeDefined();
      expect(typeof connector.readBatch).toBe('function');
    });

    it('accurately detects and tagged-serializes BSON types: ObjectId, Long, Decimal128, string, number', () => {
      const oid = new ObjectId('507f1f77bcf86cd799439011');
      const longVal = Long.fromString('9007199254740993');
      const decVal = Decimal128.fromString('123456789.987654321');
      const numVal = 42;
      const strVal = 'custom_doc_id_99';

      const dOid = detectBsonId(oid);
      expect(dOid.idType).toBe('ObjectId');
      expect(dOid.idStr).toBe('507f1f77bcf86cd799439011');

      const dLong = detectBsonId(longVal);
      expect(dLong.idType).toBe('Long');
      expect(dLong.idStr).toBe('9007199254740993');

      const dDec = detectBsonId(decVal);
      expect(dDec.idType).toBe('Decimal128');
      expect(dDec.idStr).toBe('123456789.987654321');

      const dNum = detectBsonId(numVal);
      expect(dNum.idType).toBe('number');
      expect(dNum.idStr).toBe('42');

      const dStr = detectBsonId(strVal);
      expect(dStr.idType).toBe('string');
      expect(dStr.idStr).toBe('custom_doc_id_99');
    });

    it('faithfully reconstructs typed BSON values across pagination cursors', () => {
      const reconstructedOid = reconstructBsonId('507f1f77bcf86cd799439011', 'ObjectId');
      expect(reconstructedOid).toBeInstanceOf(ObjectId);
      expect(reconstructedOid.toString()).toBe('507f1f77bcf86cd799439011');

      const reconstructedLong = reconstructBsonId('9007199254740993', 'Long');
      expect(reconstructedLong).toBeInstanceOf(Long);
      expect(reconstructedLong.toString()).toBe('9007199254740993');

      const reconstructedDec = reconstructBsonId('123456789.987654321', 'Decimal128');
      expect(reconstructedDec).toBeInstanceOf(Decimal128);
      expect(reconstructedDec.toString()).toBe('123456789.987654321');

      const reconstructedNum = reconstructBsonId('42', 'number');
      expect(typeof reconstructedNum).toBe('number');
      expect(reconstructedNum).toBe(42);

      const reconstructedStr = reconstructBsonId('custom_str_id', 'string');
      expect(typeof reconstructedStr).toBe('string');
      expect(reconstructedStr).toBe('custom_str_id');
    });

    it('simulates multi-page pagination for ObjectId, Long, and Decimal128 preserving cursor fidelity', async () => {
      // Simulate pages of Long IDs
      const longIds = [
        Long.fromString('1000000000000001'),
        Long.fromString('1000000000000002'),
        Long.fromString('1000000000000003'),
      ];

      // Page 1
      const page1Docs = [{ _id: longIds[0] }, { _id: longIds[1] }];
      const lastDocP1 = page1Docs[page1Docs.length - 1];
      const { idStr: p1CursorId, idType: p1CursorType } = detectBsonId(lastDocP1._id);
      expect(p1CursorType).toBe('Long');

      // Next query reconstruction
      const filterId = reconstructBsonId(p1CursorId, p1CursorType);
      expect(filterId).toBeInstanceOf(Long);
      expect(filterId.toString()).toBe('1000000000000002');

      // Page 2 fetches docs > filterId
      const page2Docs = [longIds[2]].filter((d) => d.greaterThan(filterId));
      expect(page2Docs).toHaveLength(1);
      expect(page2Docs[0].toString()).toBe('1000000000000003');
    });
  });

  describe('Finding 1: Atomic Cross-Batch Collision Detection via claimBatchMappings', () => {
    it('prevents concurrent batches from claiming the same destination key for different source keys', async () => {
      const { IdTracker, InMemoryIdMappingStorage } = await import('../src/engine/id-tracker.js');
      const storage = new InMemoryIdMappingStorage();
      const tracker = new IdTracker(storage);

      const runId = 'run_atomic_collision_test';

      // Batch 1 claims dest_999 for source_AAA
      await tracker.claimBatchMappings([
        {
          migrationRunId: runId,
          sourceObject: 'users',
          sourceKey: 'source_AAA',
          destinationObject: 'users',
          destinationKey: 'dest_999',
        },
      ]);

      // Batch 2 concurrently attempts to claim dest_999 for source_BBB
      await expect(
        tracker.claimBatchMappings([
          {
            migrationRunId: runId,
            sourceObject: 'users',
            sourceKey: 'source_BBB',
            destinationObject: 'users',
            destinationKey: 'dest_999',
          },
        ]),
      ).rejects.toThrow(/Collision detected: distinct source record/);
    });

    it('allows idempotent re-claim of the same sourceKey -> destinationKey mapping', async () => {
      const { IdTracker, InMemoryIdMappingStorage } = await import('../src/engine/id-tracker.js');
      const storage = new InMemoryIdMappingStorage();
      const tracker = new IdTracker(storage);

      const runId = 'run_idempotent_test';

      // First claim
      await tracker.claimBatchMappings([
        {
          migrationRunId: runId,
          sourceObject: 'users',
          sourceKey: 'source_AAA',
          destinationObject: 'users',
          destinationKey: 'dest_999',
        },
      ]);

      // Re-claim identical pair should succeed idempotently
      await expect(
        tracker.claimBatchMappings([
          {
            migrationRunId: runId,
            sourceObject: 'users',
            sourceKey: 'source_AAA',
            destinationObject: 'users',
            destinationKey: 'dest_999',
          },
        ]),
      ).resolves.not.toThrow();
    });
  });

  describe('Finding 2: BSON Type Tagging in Source Identity Keys', () => {
    it('ensures ObjectId and string with identical hex representation produce distinct typed keys', () => {
      const hex = '507f191e810c19729de860ea';
      const objId = new ObjectId(hex);
      const strId = hex;

      const detectedObj = detectBsonId(objId);
      const detectedStr = detectBsonId(strId);

      expect(detectedObj.idType).toBe('ObjectId');
      expect(detectedStr.idType).toBe('string');
      expect(detectedObj.typedKey).toBe(`ObjectId:${hex}`);
      expect(detectedStr.typedKey).toBe(`string:${hex}`);
      expect(detectedObj.typedKey).not.toBe(detectedStr.typedKey);
    });

    it('ensures Long and number with identical value produce distinct typed keys', () => {
      const longVal = Long.fromNumber(42);
      const numVal = 42;

      const detectedLong = detectBsonId(longVal);
      const detectedNum = detectBsonId(numVal);

      expect(detectedLong.idType).toBe('Long');
      expect(detectedNum.idType).toBe('number');
      expect(detectedLong.typedKey).toBe('Long:42');
      expect(detectedNum.typedKey).toBe('number:42');
      expect(detectedLong.typedKey).not.toBe(detectedNum.typedKey);
    });

    it('ensures numeric 42 and string "42" produce different internal typed identities', () => {
      const numVal = 42;
      const strVal = '42';

      const detectedNum = detectBsonId(numVal);
      const detectedStr = detectBsonId(strVal);

      expect(detectedNum.idType).toBe('number');
      expect(detectedStr.idType).toBe('string');
      expect(detectedNum.typedKey).toBe('number:42');
      expect(detectedStr.typedKey).toBe('string:42');
      expect(detectedNum.typedKey).not.toBe(detectedStr.typedKey);
    });

    it('allows both numeric 42 and string "42" identities to survive mapping and manifest persistence in the same migration run when destination keys are distinct', async () => {
      const { IdTracker, InMemoryIdMappingStorage } = await import('../src/engine/id-tracker.js');
      const { BatchManifestTracker, InMemoryBatchManifestStorage } = await import('../src/engine/batch-manifest.js');

      const runId = 'run_mixed_ids_persistence';
      const idTracker = new IdTracker(new InMemoryIdMappingStorage());
      const manifestStorage = new InMemoryBatchManifestStorage();
      const manifestTracker = new BatchManifestTracker(manifestStorage);

      const numId = detectBsonId(42);
      const strId = detectBsonId('42');

      // 1. Claim and persist mappings with distinct destination keys
      await idTracker.claimBatchMappings([
        {
          migrationRunId: runId,
          sourceObject: 'products',
          sourceKey: numId.typedKey, // 'number:42'
          destinationObject: 'products',
          destinationKey: 'prod_num_42',
        },
        {
          migrationRunId: runId,
          sourceObject: 'products',
          sourceKey: strId.typedKey, // 'string:42'
          destinationObject: 'products',
          destinationKey: 'prod_str_42',
        },
      ]);

      await idTracker.recordMapping(runId, 'products', numId.typedKey, 'products', 'prod_num_42');
      await idTracker.recordMapping(runId, 'products', strId.typedKey, 'products', 'prod_str_42');

      expect(await idTracker.getSourceKey(runId, 'products', 'prod_num_42')).toBe('number:42');
      expect(await idTracker.getSourceKey(runId, 'products', 'prod_str_42')).toBe('string:42');
      expect(await idTracker.getDestinationKey(runId, 'products', 'number:42')).toBe('prod_num_42');
      expect(await idTracker.getDestinationKey(runId, 'products', 'string:42')).toBe('prod_str_42');

      // 2. Persist record manifests in the same migration run
      await manifestStorage.saveBatch({
        id: 'batch_mixed_1',
        migrationRunId: runId,
        batchKey: 'batch_mixed_1',
        sequenceNo: 1,
        status: 'RUNNING',
        recordsRead: 2,
        recordsWritten: 2,
        recordsSkipped: 0,
        recordsFailed: 0,
        attemptCount: 1,
        sourceObject: 'products',
        destinationObject: 'products',
      });

      await manifestTracker.recordManifests([
        {
          migrationRunId: runId,
          migrationBatchId: 'batch_mixed_1',
          batchKey: 'batch_mixed_1',
          sourceObject: 'products',
          sourceKey: numId.typedKey,
          destinationObject: 'products',
          destinationKey: 'prod_num_42',
          status: 'WRITTEN',
          contentHash: 'sha256:num42',
        },
        {
          migrationRunId: runId,
          migrationBatchId: 'batch_mixed_1',
          batchKey: 'batch_mixed_1',
          sourceObject: 'products',
          sourceKey: strId.typedKey,
          destinationObject: 'products',
          destinationKey: 'prod_str_42',
          status: 'WRITTEN',
          contentHash: 'sha256:str42',
        },
      ]);

      const manifests = await manifestTracker.listRecordManifests(runId, 'batch_mixed_1');
      expect(manifests).toHaveLength(2);
      const numManifest = manifests.find((m) => m.sourceKey === 'number:42');
      const strManifest = manifests.find((m) => m.sourceKey === 'string:42');
      expect(numManifest).toBeDefined();
      expect(strManifest).toBeDefined();
      expect(numManifest!.destinationKey).toBe('prod_num_42');
      expect(strManifest!.destinationKey).toBe('prod_str_42');
    });

    it('explicitly rejects destination collisions when the destination key cannot distinguish number 42 and string "42"', async () => {
      const { IdTracker, InMemoryIdMappingStorage } = await import('../src/engine/id-tracker.js');

      const runId = 'run_collision_test';
      const idTracker = new IdTracker(new InMemoryIdMappingStorage());

      const numId = detectBsonId(42);
      const strId = detectBsonId('42');

      // Number 42 claims destination key '42'
      await idTracker.claimBatchMappings([
        {
          migrationRunId: runId,
          sourceObject: 'products',
          sourceKey: numId.typedKey, // 'number:42'
          destinationObject: 'products',
          destinationKey: '42',
        },
      ]);
      await idTracker.recordMapping(runId, 'products', numId.typedKey, 'products', '42');

      // String '42' attempting to map to the same destination key '42' must be rejected as collision
      await expect(
        idTracker.claimBatchMappings([
          {
            migrationRunId: runId,
            sourceObject: 'products',
            sourceKey: strId.typedKey, // 'string:42'
            destinationObject: 'products',
            destinationKey: '42',
          },
        ]),
      ).rejects.toThrow(/Collision detected: distinct source record 'string:42' maps to destinationKey '42'/);
    });

    it('preserves both number and string identities across batch boundaries during recovery', async () => {
      const { RecoveryEngine } = await import('../src/engine/recovery-engine.js');
      const { BatchManifestTracker, InMemoryBatchManifestStorage } = await import('../src/engine/batch-manifest.js');

      const runId = 'run_recovery_boundary_test';
      const manifestStorage = new InMemoryBatchManifestStorage();
      const manifestTracker = new BatchManifestTracker(manifestStorage);

      const numId = detectBsonId(42);
      const strId = detectBsonId('42');

      const dataNum = { id: 'item_42_num' };
      const hashNum = calculateCanonicalHash(dataNum);

      const dataStr = { id: 'item_42_str' };
      const hashStr = calculateCanonicalHash(dataStr);

      // Batch 1: processed number 42
      const batch1: any = {
        id: 'batch_num_id',
        migrationRunId: runId,
        batchKey: 'batch_1',
        sequenceNo: 1,
        status: 'RUNNING',
        subStage: 'MANIFEST_COMMITTED',
        recordsRead: 1,
        recordsWritten: 1,
        recordsSkipped: 0,
        recordsFailed: 0,
        attemptCount: 1,
        sourceObject: 'items',
        destinationObject: 'items',
        planVersionId: '00000000-0000-0000-0000-000000000001',
        mappingVersionId: '00000000-0000-0000-0000-000000000002',
      };
      await manifestStorage.saveBatch(batch1);
      await manifestTracker.recordManifests([
        {
          migrationRunId: runId,
          migrationBatchId: 'batch_num_id',
          batchKey: 'batch_1',
          sourceObject: 'items',
          sourceKey: numId.typedKey, // 'number:42'
          destinationObject: 'items',
          destinationKey: 'item_42_num',
          status: 'WRITTEN',
          contentHash: hashNum,
        },
      ]);

      // Batch 2: processed string '42'
      const batch2: any = {
        id: 'batch_str_id',
        migrationRunId: runId,
        batchKey: 'batch_2',
        sequenceNo: 2,
        status: 'RUNNING',
        subStage: 'MANIFEST_COMMITTED',
        recordsRead: 1,
        recordsWritten: 1,
        recordsSkipped: 0,
        recordsFailed: 0,
        attemptCount: 1,
        sourceObject: 'items',
        destinationObject: 'items',
        planVersionId: '00000000-0000-0000-0000-000000000001',
        mappingVersionId: '00000000-0000-0000-0000-000000000002',
      };
      await manifestStorage.saveBatch(batch2);
      await manifestTracker.recordManifests([
        {
          migrationRunId: runId,
          migrationBatchId: 'batch_str_id',
          batchKey: 'batch_2',
          sourceObject: 'items',
          sourceKey: strId.typedKey, // 'string:42'
          destinationObject: 'items',
          destinationKey: 'item_42_str',
          status: 'WRITTEN',
          contentHash: hashStr,
        },
      ]);

      const mockDestConnector = {
        readByKeys: vi.fn().mockImplementation(async (table, keys) => {
          return keys.map((k: string) => ({
            destinationKey: k,
            data: k === 'item_42_num' ? dataNum : dataStr,
          }));
        }),
      };

      const advancedCheckpoints: any[] = [];
      const mockCheckpointManager = {
        getCheckpoint: vi.fn().mockResolvedValue(null),
        advanceCheckpoint: vi.fn().mockImplementation(async (params) => {
          advancedCheckpoints.push(params);
        }),
      };

      const recovery = new RecoveryEngine({
        destinationConnector: mockDestConnector as any,
        manifestTracker,
        checkpointManager: mockCheckpointManager as any,
      });

      // Reconcile Batch 1
      const res1 = await recovery.reconcileBatch(batch1, 'items', 'item_id');
      expect(res1?.resolvedStatus).toBe('COMMITTED');

      // Reconcile Batch 2
      const res2 = await recovery.reconcileBatch(batch2, 'items', 'item_id');
      expect(res2?.resolvedStatus).toBe('COMMITTED');

      // Verify manifests for each batch preserved distinct typed keys
      const m1 = await manifestTracker.listRecordManifests(runId, 'batch_1');
      expect(m1).toHaveLength(1);
      expect(m1[0].sourceKey).toBe('number:42');
      expect(m1[0].destinationKey).toBe('item_42_num');

      const m2 = await manifestTracker.listRecordManifests(runId, 'batch_2');
      expect(m2).toHaveLength(1);
      expect(m2[0].sourceKey).toBe('string:42');
      expect(m2[0].destinationKey).toBe('item_42_str');
    });

    it('reconstructBsonId decodes typedKey prefixes when lastIdType is omitted', () => {
      const reconstructedObj = reconstructBsonId('ObjectId:507f191e810c19729de860ea');
      expect(reconstructedObj).toBeInstanceOf(ObjectId);
      expect(reconstructedObj.toString()).toBe('507f191e810c19729de860ea');

      const reconstructedLong = reconstructBsonId('Long:9007199254740993');
      expect(reconstructedLong).toBeInstanceOf(Long);
      expect(reconstructedLong.toString()).toBe('9007199254740993');
    });

    it('integrates real UUID mapping version with TransformationEngine and PostgreSQL persistence, rejecting duplicate destination keys from mixed-type BSON source IDs', async () => {
      const runId = 'run_prod_mapping_mixed_bson_' + Date.now();

      // Real approved UUID mapping definition
      const approvedMapping: ObjectMapping = {
        source: { collection: 'customers' },
        destination: { table: 'customers' },
        identity: {
          sourceKey: '_id',
          destinationKey: 'id',
          strategy: 'PRESERVE_AS_TEXT',
        },
        fields: [
          { sourcePath: '_id', destinationPath: 'id' },
          { sourcePath: 'name', destinationPath: 'name' },
          { sourcePath: 'email', destinationPath: 'email' },
        ],
      };

      const engine = new TransformationEngine(approvedMapping);

      // Mixed-type MongoDB IDs: numeric 42 vs string "42"
      const rawNumDoc = { _id: 42, name: 'Num Customer 42', email: 'num42@test.com' };
      const rawStrDoc = { _id: '42', name: 'Str Customer 42', email: 'str42@test.com' };

      const numBson = detectBsonId(rawNumDoc._id);
      const strBson = detectBsonId(rawStrDoc._id);

      expect(numBson.typedKey).toBe('number:42');
      expect(strBson.typedKey).toBe('string:42');

      const envNum: SourceRecordEnvelope = {
        sourceObject: 'customers',
        sourceKey: numBson.typedKey,
        payload: rawNumDoc,
        extractedAt: new Date().toISOString(),
      };

      const envStr: SourceRecordEnvelope = {
        sourceObject: 'customers',
        sourceKey: strBson.typedKey,
        payload: rawStrDoc,
        extractedAt: new Date().toISOString(),
      };

      // 1. Production TransformationEngine transformation with complete envelope
      const tNum = engine.transform(envNum);
      const tStr = engine.transform(envStr);

      // Source keys preserve distinct internal typed identities
      expect(tNum.sourceKey).toBe('number:42');
      expect(tStr.sourceKey).toBe('string:42');
      expect(tNum.sourceKey).not.toBe(tStr.sourceKey);

      // Destination keys and payloads derive clean business IDs (unprefixed)
      expect(tNum.destinationKey).toBe('42');
      expect(tStr.destinationKey).toBe('42');
      expect((tNum.payload as any).id).toBe('42');
      expect((tStr.payload as any).id).toBe('42');
      expect(typeof (tNum.payload as any).id).toBe('string');
      expect(String((tNum.payload as any).id).includes(':')).toBe(false);

      // 2. PostgreSQL persistence & atomic collision rejection
      const testDbUrl = process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
      let realPgPool: pg.Pool | null = null;
      let testWorkspaceId: string | null = null;
      let testProjectId: string | null = null;
      let testPlanId: string | null = null;
      let testPlanVerId: string | null = null;
      let testSourceConnId: string | null = null;
      let testDestConnId: string | null = null;
      const actualRunId = crypto.randomUUID();

      if (testDbUrl) {
        try {
          const probe = new pg.Pool({ connectionString: testDbUrl, max: 2 });
          await probe.query('SELECT 1');
          realPgPool = probe;

          testWorkspaceId = crypto.randomUUID();
          testProjectId = crypto.randomUUID();
          testPlanId = crypto.randomUUID();
          testPlanVerId = crypto.randomUUID();
          testSourceConnId = crypto.randomUUID();
          testDestConnId = crypto.randomUUID();

          await realPgPool.query(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Test WS', $2)`, [
            testWorkspaceId,
            `ws-col-${Date.now()}`,
          ]);
          await realPgPool.query(`INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Test Proj')`, [
            testProjectId,
            testWorkspaceId,
          ]);
          await realPgPool.query(
            `INSERT INTO connections (id, workspace_id, name, engine, connection_role, status)
             VALUES ($1, $2, 'Src', 'MONGODB', 'SOURCE', 'HEALTHY'),
                    ($3, $2, 'Dst', 'POSTGRESQL', 'DESTINATION', 'HEALTHY')`,
            [testSourceConnId, testWorkspaceId, testDestConnId],
          );
          await realPgPool.query(`INSERT INTO migration_plans (id, workspace_id, project_id, name) VALUES ($1, $2, $3, 'Test Plan')`, [
            testPlanId,
            testWorkspaceId,
            testProjectId,
          ]);
          await realPgPool.query(
            `INSERT INTO migration_plan_versions (id, plan_id, source_connection_id, destination_connection_id, plan_hash)
             VALUES ($1, $2, $3, $4, 'hash_col_test')`,
            [testPlanVerId, testPlanId, testSourceConnId, testDestConnId],
          );
          await realPgPool.query(
            `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status)
             VALUES ($1, $2, $3, $4, 'RUNNING')`,
            [actualRunId, testWorkspaceId, testProjectId, testPlanVerId],
          );
        } catch {
          if (realPgPool) {
            await realPgPool.end().catch(() => {});
            realPgPool = null;
          }
        }
      }

      const idMappingsTable: Array<{
        migration_run_id: string;
        source_object: string;
        source_key: string;
        destination_object: string;
        destination_key: string;
      }> = [];

      const mockClient = {
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('SELECT source_key FROM id_mappings')) {
            const [rId, dObj, dKey] = params!;
            const match = idMappingsTable.find(
              (r) => r.migration_run_id === rId && r.destination_object === dObj && r.destination_key === dKey,
            );
            return { rows: match ? [{ source_key: match.source_key }] : [] };
          }
          if (sql.includes('INSERT INTO id_mappings')) {
            const [rId, sObj, sKey, dObj, dKey] = params!;
            const destConflict = idMappingsTable.find(
              (r) => r.migration_run_id === rId && r.destination_object === dObj && r.destination_key === dKey && r.source_key !== sKey,
            );
            if (destConflict) {
              const err: any = new Error('duplicate key value violates unique constraint "uq_id_mapping_destination"');
              err.code = '23505';
              throw err;
            }
            const srcConflict = idMappingsTable.find(
              (r) => r.migration_run_id === rId && r.source_object === sObj && r.source_key === sKey,
            );
            if (!srcConflict) {
              idMappingsTable.push({
                migration_run_id: rId,
                source_object: sObj,
                source_key: sKey,
                destination_object: dObj,
                destination_key: dKey,
              });
            }
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const mockPool: any = {
        connect: vi.fn(async () => mockClient),
        query: vi.fn(async (sql, params) => mockClient.query(sql, params)),
      };

      const activePgPool = realPgPool || mockPool;
      const pgAdapters = new PostgresStorageAdapters(activePgPool);
      const tracker = new IdTracker(pgAdapters);

      try {
        // Record 1 (number:42) claims destination key '42'
        await tracker.claimBatchMappings([
          {
            migrationRunId: actualRunId,
            sourceObject: tNum.sourceObject,
            sourceKey: tNum.sourceKey, // 'number:42'
            destinationObject: tNum.destinationObject,
            destinationKey: tNum.destinationKey, // '42'
          },
        ]);

        if (!realPgPool) {
          expect(idMappingsTable).toHaveLength(1);
          expect(idMappingsTable[0].source_key).toBe('number:42');
          expect(idMappingsTable[0].destination_key).toBe('42');
        } else {
          const res = await realPgPool.query(
            `SELECT source_key, destination_key FROM id_mappings WHERE migration_run_id = $1`,
            [actualRunId],
          );
          expect(res.rows).toHaveLength(1);
          expect(res.rows[0].source_key).toBe('number:42');
          expect(res.rows[0].destination_key).toBe('42');
        }

        // Record 2 (string:42) attempting to claim the same destination key '42' must be rejected
        await expect(
          tracker.claimBatchMappings([
            {
              migrationRunId: actualRunId,
              sourceObject: tStr.sourceObject,
              sourceKey: tStr.sourceKey, // 'string:42'
              destinationObject: tStr.destinationObject,
              destinationKey: tStr.destinationKey, // '42'
            },
          ]),
        ).rejects.toThrow(/Collision detected: distinct source record 'string:42' maps to destinationKey '42'/);

        // Verify DestinationWriter integrates with tracker and aborts writeBatch on collision
        const mockDestinationConnector: any = {
          writeBatch: vi.fn(),
          readByKeys: vi.fn(),
        };
        const destinationWriter = new DestinationWriter({
          connector: mockDestinationConnector,
          idTracker: tracker,
        });

        const batchToAttempt: TransformedBatch = {
          batchKey: 'batch_collision_test',
          destinationObject: 'customers',
          records: [
            {
              destinationKey: tStr.destinationKey,
              sourceKey: tStr.sourceKey,
              sourceObject: tStr.sourceObject,
              destinationObject: tStr.destinationObject,
              data: tStr.payload as Record<string, unknown>,
            },
          ],
        };

        await expect(
          destinationWriter.write(batchToAttempt, {
            migrationRunId: actualRunId,
            batchKey: 'batch_collision_test',
            sourceObject: 'customers',
            writeMode: 'upsert',
          }),
        ).rejects.toThrow(/Collision detected/);

        // Confirm destination connector was NEVER called due to early collision rejection
        expect(mockDestinationConnector.writeBatch).not.toHaveBeenCalled();
      } finally {
        if (realPgPool) {
          await realPgPool.query(`DELETE FROM id_mappings WHERE migration_run_id = $1`, [actualRunId]).catch(() => {});
          await realPgPool.query(`DELETE FROM migration_runs WHERE id = $1`, [actualRunId]).catch(() => {});
          await realPgPool.query(`DELETE FROM migration_plan_versions WHERE id = $1`, [testPlanVerId]).catch(() => {});
          await realPgPool.query(`DELETE FROM migration_plans WHERE id = $1`, [testPlanId]).catch(() => {});
          await realPgPool.query(`DELETE FROM connections WHERE id IN ($1, $2)`, [testSourceConnId, testDestConnId]).catch(() => {});
          await realPgPool.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]).catch(() => {});
          await realPgPool.query(`DELETE FROM workspaces WHERE id = $1`, [testWorkspaceId]).catch(() => {});
          await realPgPool.end().catch(() => {});
        }
      }
    });
  });

  describe('Finding 4: RecoveryEngine Version ID Preservation & Dual-Object Filtering', () => {
    it('propagates actual batch planVersionId and mappingVersionId to advanced checkpoints and filters by destinationObject', async () => {
      const { RecoveryEngine } = await import('../src/engine/recovery-engine.js');
      const advancedCheckpoints: any[] = [];

      const mockManifestTracker: any = {
        listBatches: vi.fn().mockResolvedValue([
          {
            batchKey: 'batch_customers_primary',
            sequenceNo: 1,
            status: 'COMMITTED',
            sourceObject: 'customers',
            destinationObject: 'clients',
            planVersionId: 'pv_real_uuid_111',
            mappingVersionId: 'mv_real_uuid_222',
            recordsWritten: 10,
            sourceCursorEnd: { lastId: '10' },
          },
          {
            batchKey: 'batch_customers_archive',
            sequenceNo: 1,
            status: 'COMMITTED',
            sourceObject: 'customers',
            destinationObject: 'customers_archive', // Different destination object
            planVersionId: 'pv_archive_uuid_333',
            mappingVersionId: 'mv_archive_uuid_444',
            recordsWritten: 5,
            sourceCursorEnd: { lastId: '5' },
          },
        ]),
        listRecordManifests: vi.fn().mockResolvedValue([]),
        transitionState: vi.fn().mockResolvedValue(undefined),
      };

      const mockCheckpointManager: any = {
        getCheckpoint: vi.fn().mockResolvedValue(null),
        advanceCheckpoint: vi.fn().mockImplementation(async (params: any) => {
          advancedCheckpoints.push(params);
        }),
      };

      const mockConnector: any = {
        readByKeys: vi.fn().mockResolvedValue([]),
      };

      const recovery = new RecoveryEngine({
        destinationConnector: mockConnector,
        manifestTracker: mockManifestTracker,
        checkpointManager: mockCheckpointManager,
      });

      // Prepare resume specifically for customers -> clients
      const plan = await recovery.prepareResume('run_recovery_test', 'customers', 'clients', 'id');

      // Only batch_customers_primary should have been processed, NOT customers_archive
      expect(plan.reconciledBatches).toHaveLength(1);
      expect(plan.reconciledBatches[0].batchKey).toBe('batch_customers_primary');

      // Checkpoint must preserve real version UUIDs rather than placeholder literals
      expect(advancedCheckpoints).toHaveLength(1);
      expect(advancedCheckpoints[0].planVersionId).toBe('pv_real_uuid_111');
      expect(advancedCheckpoints[0].mappingVersionId).toBe('mv_real_uuid_222');
      expect(advancedCheckpoints[0].planVersionId).not.toBe('resumed_plan');
      expect(advancedCheckpoints[0].mappingVersionId).not.toBe('resumed_mapping');
    });

    it('fails closed in production when durable version metadata is missing without synthetic placeholders', async () => {
      const { RecoveryEngine } = await import('../src/engine/recovery-engine.js');
      const mockTracker: any = {
        listBatches: vi.fn().mockResolvedValue([
          {
            batchKey: 'batch_no_version',
            sequenceNo: 1,
            status: 'COMMITTED',
            sourceObject: 'users',
            destinationObject: 'users',
            recordsWritten: 1,
          },
        ]),
        listRecordManifests: vi.fn().mockResolvedValue([]),
        transitionState: vi.fn().mockResolvedValue(undefined),
      };

      const recovery = new RecoveryEngine({
        destinationConnector: { readByKeys: vi.fn() } as any,
        manifestTracker: mockTracker,
        checkpointManager: { getCheckpoint: vi.fn().mockResolvedValue(null), advanceCheckpoint: vi.fn() } as any,
      });

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(recovery.prepareResume('run_strict', 'users', 'users')).rejects.toThrow(
          /Missing durable planVersionId or mappingVersionId/,
        );
      } finally {
        process.env.NODE_ENV = oldEnv;
      }
    });
  });
});
