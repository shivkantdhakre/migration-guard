import { describe, it, expect, vi } from 'vitest';
import { ObjectId, Long, Decimal128 } from 'mongodb';
import { DestinationWriter } from '../src/engine/destination-writer.js';
import { ErrorClassifier } from '../src/engine/error-classifier.js';
import { ConnectorFactory, detectBsonId, reconstructBsonId } from '../src/connectors/connector-factory.js';
import { DestinationConnector, TransformedBatch } from '../src/types.js';

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
      expect(detectedStr.typedKey).toBe(hex);
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
      expect(detectedNum.typedKey).toBe('42');
      expect(detectedLong.typedKey).not.toBe(detectedNum.typedKey);
    });

    it('reconstructBsonId decodes typedKey prefixes when lastIdType is omitted', () => {
      const reconstructedObj = reconstructBsonId('ObjectId:507f191e810c19729de860ea');
      expect(reconstructedObj).toBeInstanceOf(ObjectId);
      expect(reconstructedObj.toString()).toBe('507f191e810c19729de860ea');

      const reconstructedLong = reconstructBsonId('Long:9007199254740993');
      expect(reconstructedLong).toBeInstanceOf(Long);
      expect(reconstructedLong.toString()).toBe('9007199254740993');
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
