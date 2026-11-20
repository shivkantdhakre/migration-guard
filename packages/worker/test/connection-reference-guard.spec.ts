import { describe, expect, it } from 'vitest';
import { QueueHandler } from '../src/engine/queue-handler.js';
import { MigrationJobPayload } from '../src/types.js';

describe('Connection Reference Guard (P0.4)', () => {
  const validBasePayload: MigrationJobPayload = {
    jobId: 'job_001',
    migrationRunId: 'run_123',
    batchKey: 'batch_001',
    sequenceNo: 1,
    sourceObject: 'customers',
    destinationObject: 'customers',
    cursorStart: null,
    batchSize: 100,
    planVersionId: 'plan_v1',
    mappingVersionId: 'map_v1',
    writeMode: 'upsert',
    sourceConnectionId: 'a8a3a169-62be-4fd4-974e-e9c705dc9d1c',
    destinationConnectionId: '7ebf7e42-1ee6-4069-9cc5-2af5185b7153',
  };

  it('accepts payload when both sourceConnectionId and destinationConnectionId are present', () => {
    expect(() => QueueHandler.validatePayload(validBasePayload, { requireConnections: true })).not.toThrow();
  });

  it('rejects payload when sourceConnectionId is missing', () => {
    const invalid = { ...validBasePayload, sourceConnectionId: undefined };
    expect(() => QueueHandler.validatePayload(invalid, { requireConnections: true })).toThrow(
      /Queue payload missing required property: sourceConnectionId/,
    );
  });

  it('rejects payload when destinationConnectionId is missing', () => {
    const invalid = { ...validBasePayload, destinationConnectionId: undefined };
    expect(() => QueueHandler.validatePayload(invalid, { requireConnections: true })).toThrow(
      /Queue payload missing required property: destinationConnectionId/,
    );
  });

  it('rejects payload when connection IDs are empty strings', () => {
    const invalid = { ...validBasePayload, sourceConnectionId: '' };
    expect(() => QueueHandler.validatePayload(invalid, { requireConnections: true })).toThrow(
      /Queue payload missing required property: sourceConnectionId/,
    );
  });

  it('enforces connection IDs automatically in production environment', () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const invalid = { ...validBasePayload, sourceConnectionId: undefined };
      expect(() => QueueHandler.validatePayload(invalid)).toThrow(
        /Queue payload missing required property: sourceConnectionId/,
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
