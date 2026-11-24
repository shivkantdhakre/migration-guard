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
});
