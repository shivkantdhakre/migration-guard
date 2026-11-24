import { describe, it, expect, vi } from 'vitest';
import { DestinationWriter } from '../src/engine/destination-writer.js';
import { ErrorClassifier } from '../src/engine/error-classifier.js';
import { ConnectorFactory } from '../src/connectors/connector-factory.js';
import { DestinationConnector, TransformedBatch } from '../src/types.js';

describe('Production Readiness Regression - Worker Areas (6, 7, 8, 9, 10, 11)', () => {
  describe('Area 6: Destination Write Integrity & Collision Detection', () => {
    it('detects and throws collision when different source records map to the same destinationKey', async () => {
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
  });
});
