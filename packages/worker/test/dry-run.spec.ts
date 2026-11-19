import { describe, expect, it } from 'vitest';
import { DryRunEngine } from '../src/engine/dry-run.js';
import { SourceRecordEnvelope } from '../src/types.js';
import { MockSourceConnector } from './helpers/mock-connectors.js';

describe('Dry Run Engine (FR-PLAN-003)', () => {
  it('executes transform against sample records and validates shape without destination writes', async () => {
    const mockRecords: SourceRecordEnvelope[] = [
      {
        sourceObject: 'customers',
        sourceKey: 'c1',
        payload: { name: 'Alice', email: 'alice@test.com' },
        extractedAt: new Date().toISOString(),
      },
      {
        sourceObject: 'customers',
        sourceKey: 'c2',
        payload: { name: 'Bob', email: null }, // Missing required email
        extractedAt: new Date().toISOString(),
      },
      {
        sourceObject: 'customers',
        sourceKey: 'c3',
        payload: { name: 'Charlie', email: 'charlie@test.com' },
        extractedAt: new Date().toISOString(),
      },
    ];

    const sourceConnector = new MockSourceConnector(mockRecords);
    const engine = new DryRunEngine(sourceConnector);

    const result = await engine.execute({
      sourceObject: 'customers',
      sampleSize: 10,
      requiredFields: ['name', 'email'],
    });

    expect(result.recordsRead).toBe(3);
    expect(result.recordsTransformed).toBe(3);
    expect(result.recordsWouldWrite).toBe(3);
    expect(result.sampleRecords.length).toBe(3);

    // Should flag warning for Bob's null email
    expect(result.validationIssues.length).toBe(1);
    expect(result.validationIssues[0].sourceKey).toBe('c2');
    expect(result.validationIssues[0].fieldPath).toBe('email');
    expect(result.validationIssues[0].severity).toBe('WARNING');
  });

  it('captures transform exceptions in validationIssues without halting dry run', async () => {
    const mockRecords: SourceRecordEnvelope[] = [
      {
        sourceObject: 'items',
        sourceKey: 'i1',
        payload: { val: 'valid' },
        extractedAt: new Date().toISOString(),
      },
      {
        sourceObject: 'items',
        sourceKey: 'i2',
        payload: { val: 'corrupt' },
        extractedAt: new Date().toISOString(),
      },
    ];

    const sourceConnector = new MockSourceConnector(mockRecords);
    const engine = new DryRunEngine(sourceConnector);

    const result = await engine.execute({
      sourceObject: 'items',
      transformFn: (env) => {
        if (env.sourceKey === 'i2') {
          throw new Error('Malformed JSON payload');
        }
        return {
          destinationKey: env.sourceKey,
          sourceKey: env.sourceKey,
          sourceObject: env.sourceObject,
          destinationObject: env.sourceObject,
          data: { id: env.sourceKey, ...(env.payload as Record<string, unknown>) },
        };
      },
    });

    expect(result.recordsRead).toBe(2);
    expect(result.recordsTransformed).toBe(1);
    expect(result.recordsFailed).toBe(1);
    expect(result.validationIssues.length).toBe(1);
    expect(result.validationIssues[0].sourceKey).toBe('i2');
    expect(result.validationIssues[0].message).toContain('Malformed JSON payload');
  });
});
