import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  MigrationPlanProposalSchema,
  SchemaMappingProposalSchema,
  TransformSuggestionSchema,
  RiskAssessmentSchema,
  FailureInvestigationSchema,
  DiscrepancyInvestigationSchema,
  RepairProposalSchema,
  CopilotResponseSchema,
} from '../../src/ai/schemas/index.js';
import { MockProvider } from '../../src/ai/providers/mock-provider.js';

describe('Structured Schema Output Validation (FR-AI-003)', () => {
  it('should validate MigrationPlanProposalSchema structure', () => {
    const validPlan = {
      schemaVersion: 'plan-proposal.v1',
      userObjective: 'Migrate MongoDB to PostgreSQL',
      sourceConnectionId: 'conn-1',
      targetConnectionId: 'conn-2',
      strategy: {
        batchSize: 1000,
        concurrency: 4,
        writeMode: 'UPSERT_BY_KEY',
        idStrategy: 'PRESERVE_AS_TEXT',
        retryLimit: 3,
      },
      selectedObjects: [
        {
          sourceCollection: 'customers',
          destinationTable: 'customers',
          identityMapping: {
            sourceKey: '_id',
            destinationKey: 'source_id',
            strategy: 'PRESERVE_AS_TEXT',
          },
        },
      ],
      assumptions: [],
      risks: [],
      unresolvedQuestions: [],
      requiresReview: true,
    };

    const parsed = MigrationPlanProposalSchema.parse(validPlan);
    expect(parsed.schemaVersion).toBe('plan-proposal.v1');
    expect(parsed.strategy.batchSize).toBe(1000);
  });

  it('should reject invalid MigrationPlanProposal missing required fields', () => {
    const invalidPlan = {
      schemaVersion: 'plan-proposal.v1',
      // Missing userObjective and selectedObjects
    };

    expect(() => MigrationPlanProposalSchema.parse(invalidPlan)).toThrow();
  });

  it('should validate SchemaMappingProposalSchema with allowlisted transforms', () => {
    const validMapping = {
      schemaVersion: 'mapping-proposal.v1',
      sourceObject: 'customers',
      destinationObject: 'customers',
      proposals: [
        {
          sourcePath: 'name',
          destinationPath: 'name',
          transform: { op: 'TRIM_STRING' },
          confidence: 0.95,
          rationale: 'Clean whitespace',
          assumptions: [],
          requiresReview: false,
        },
      ],
      unresolved: [
        {
          sourcePath: 'orders',
          reason: 'Child table needed',
          question: 'Map to separate table?',
        },
      ],
      overallConfidence: 0.9,
    };

    const parsed = SchemaMappingProposalSchema.parse(validMapping);
    expect(parsed.proposals[0].transform.op).toBe('TRIM_STRING');
  });

  it('should reject non-allowlisted transform operations in SchemaMappingProposalSchema', () => {
    const invalidMapping = {
      schemaVersion: 'mapping-proposal.v1',
      sourceObject: 'customers',
      destinationObject: 'customers',
      proposals: [
        {
          sourcePath: 'name',
          destinationPath: 'name',
          transform: { op: 'EXECUTE_CUSTOM_SCRIPT' }, // FORBIDDEN OP
          confidence: 0.95,
          rationale: 'Arbitrary code',
          assumptions: [],
          requiresReview: true,
        },
      ],
      unresolved: [],
      overallConfidence: 0.9,
    };

    expect(() => SchemaMappingProposalSchema.parse(invalidMapping)).toThrow();
  });

  it('should perform bounded 1-retry when LLM initially generates malformed output', async () => {
    const provider = new MockProvider();
    // Configure provider to fail the initial attempt to test the bounded retry
    provider.setFailAttempts(1);

    const testSchema = z.object({
      schemaVersion: z.literal('plan-proposal.v1'),
      userObjective: z.string(),
      strategy: z.object({ batchSize: z.number() }),
      selectedObjects: z.array(z.any()),
    });

    const response = await provider.generateStructured(testSchema, {
      prompt: 'Draft a migration plan for customers collection',
    });

    expect(response.finishReason).toBe('retry_success');
    expect(response.parsed?.schemaVersion).toBe('plan-proposal.v1');
  });

  it('should validate RepairProposalSchema and forbid arbitrary SQL or shell script fields', () => {
    const validRepair = {
      schemaVersion: 'repair-proposal.v1',
      proposalId: 'prop-01',
      operation: 'REPROCESS_RECORDS_WITH_APPROVED_MAPPING',
      scope: {
        validationRunId: 'vrun-01',
        discrepancyIds: ['disc-01', 'disc-02'],
      },
      preconditions: ['Mapping passed test'],
      expectedEffects: ['Reprocess 2 records'],
      risks: ['Overwrites destination values'],
      requiresDryRun: true,
      requiresApproval: true,
    };

    const parsed = RepairProposalSchema.parse(validRepair);
    expect(parsed.operation).toBe('REPROCESS_RECORDS_WITH_APPROVED_MAPPING');

    // Strict mode rejection if arbitrary code or unknown fields injected
    const maliciousRepair = {
      ...validRepair,
      rawSql: 'DROP TABLE customers;',
    };
    expect(() => RepairProposalSchema.parse(maliciousRepair)).toThrow();
  });

  it('should validate CopilotResponseSchema requiring facts with typed EvidenceRefs', () => {
    const validCopilot = {
      schemaVersion: 'copilot-response.v1',
      answer: 'Status is completed.',
      facts: [
        {
          statement: 'Migration run processed 10,000 records.',
          evidenceRef: {
            type: 'RUN',
            id: 'run-01',
            label: 'Run Summary Evidence',
          },
        },
      ],
      hypotheses: [
        {
          statement: 'Timeout caused by high network latency.',
          confidence: 0.8,
          basis: 'Network log spikes',
        },
      ],
      recommendations: ['Review report'],
      evidenceRefs: [],
    };

    const parsed = CopilotResponseSchema.parse(validCopilot);
    expect(parsed.facts[0].evidenceRef.type).toBe('RUN');
  });
});
