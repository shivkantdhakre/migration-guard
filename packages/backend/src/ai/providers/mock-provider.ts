import { z } from 'zod';
import { AiProviderAdapter } from './ai-provider.interface.js';
import { GenerateOptions, ProviderResponse, TokenUsage, AiProviderName } from '../types.js';
import { DataMasker } from '../masking/data-masker.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';

export class MockProvider implements AiProviderAdapter {
  public readonly providerName: AiProviderName = 'mock';
  public readonly defaultModel: string = 'mock-deterministic-v1';

  private failNextAttempts: number = 0;
  private customNextResponse: unknown = null;
  private simulatedLatencyMs: number = 10;

  public isAvailable(): boolean {
    return true; // Mock is always available offline
  }

  /**
   * For testing: configure simulated latency
   */
  public setSimulatedLatency(ms: number): void {
    this.simulatedLatencyMs = ms;
  }

  /**
   * For testing: force the next N generate calls to return invalid data to test retry logic
   */
  public setFailAttempts(count: number): void {
    this.failNextAttempts = count;
  }

  /**
   * For testing: inject an explicit mock response
   */
  public setNextResponse(response: unknown): void {
    this.customNextResponse = response;
  }

  public async generateText(
    options: GenerateOptions
  ): Promise<ProviderResponse<string>> {
    const startTime = Date.now();
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }

    // Mask secrets and check injection
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);
    PromptSanitizer.detectInjection(sanitizedPrompt);

    const text =
      this.customNextResponse && typeof this.customNextResponse === 'string'
        ? this.customNextResponse
        : `[Mock Provider Response to: ${sanitizedPrompt.slice(0, 50)}...]`;

    this.customNextResponse = null;

    const usage: TokenUsage = {
      promptTokens: Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: Math.ceil(text.length / 4),
      totalTokens:
        Math.ceil(sanitizedPrompt.length / 4) + Math.ceil(text.length / 4),
    };

    return {
      rawText: text,
      usage,
      latencyMs: Date.now() - startTime,
      model: this.defaultModel,
      finishReason: 'stop',
    };
  }

  public async generateStructured<T>(
    schema: z.ZodType<T>,
    options: GenerateOptions
  ): Promise<ProviderResponse<T>> {
    const startTime = Date.now();
    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }

    // Sanitize prompt
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);

    // If fail attempts configured, simulate malformed output for retry testing
    if (this.failNextAttempts > 0) {
      this.failNextAttempts--;
      // Try one bounded retry (FR-AI-003)
      // On the retry, return valid data
      const malformedJson = '{"invalid": true, "corrupted": "missing required fields"}';
      const parseFirstAttempt = schema.safeParse(JSON.parse(malformedJson));
      if (!parseFirstAttempt.success) {
        // Retry logic: second attempt succeeds
        const correctedData = this.generateDeterministicForSchema(schema, sanitizedPrompt, options);
        const secondParse = schema.parse(correctedData);
        PromptSanitizer.validateSafeOutput(JSON.stringify(secondParse));

        return {
          rawText: JSON.stringify(secondParse),
          parsed: secondParse,
          usage: {
            promptTokens: 200,
            completionTokens: 150,
            totalTokens: 350,
          },
          latencyMs: Date.now() - startTime,
          model: this.defaultModel,
          finishReason: 'retry_success',
        };
      }
    }

    // Custom response if set
    let dataToValidate: unknown;
    if (this.customNextResponse !== null) {
      dataToValidate = this.customNextResponse;
      this.customNextResponse = null;
    } else {
      dataToValidate = this.generateDeterministicForSchema(schema, sanitizedPrompt, options);
    }

    // Validate against schema
    const parseResult = schema.safeParse(dataToValidate);
    if (!parseResult.success) {
      throw new Error(
        `MockProvider output failed schema validation: ${parseResult.error.message}`
      );
    }

    // Safety check against arbitrary commands in output
    PromptSanitizer.validateSafeOutput(JSON.stringify(parseResult.data));

    const jsonStr = JSON.stringify(parseResult.data);
    const usage: TokenUsage = {
      promptTokens: Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: Math.ceil(jsonStr.length / 4),
      totalTokens:
        Math.ceil(sanitizedPrompt.length / 4) + Math.ceil(jsonStr.length / 4),
    };

    return {
      rawText: jsonStr,
      parsed: parseResult.data,
      usage,
      latencyMs: Date.now() - startTime,
      model: this.defaultModel,
      finishReason: 'stop',
    };
  }

  /**
   * Deterministically construct valid mock data based on the target schema
   */
  private generateDeterministicForSchema(
    schema: z.ZodType<any>,
    prompt: string,
    options?: GenerateOptions
  ): any {
    const promptLower = prompt.toLowerCase();
    const ver = options?.schemaVersion?.toLowerCase() || '';

    // 1. Risk Assessment
    if (ver === 'risk-assessment.v1' || promptLower.includes('risk-assessment.v1')) {
      return {
        schemaVersion: 'risk-assessment.v1',
        overallRiskLevel: 'MEDIUM',
        measuredFactsCount: 2,
        hypothesesCount: 1,
        findings: [
          {
            id: 'risk-01',
            category: 'INCOMPATIBLE_TYPE',
            severity: 'HIGH',
            sourceField: 'address',
            targetField: 'address_json',
            description: 'MongoDB nested object mapped to PostgreSQL jsonb column.',
            mitigation: 'Use TO_JSONB transformer to validate JSON serialization.',
            isFact: true,
            evidenceRef: 'snapshot-schema-01',
          },
          {
            id: 'risk-02',
            category: 'MISSING_CONSTRAINT',
            severity: 'MEDIUM',
            targetField: 'email',
            description: 'Destination email column has UNIQUE constraint but source has 15 duplicate emails.',
            mitigation: 'Resolve duplicate email records before executing migration.',
            isFact: true,
            evidenceRef: 'profile-summary-01',
          },
        ],
        recommendations: [
          'Run preview transform on 100 sample records before starting production run.',
          'Add unique constraint deduplication rule to mapping.',
        ],
        readinessPass: false,
      };
    }

    // 2. Discrepancy Investigation
    if (ver === 'discrepancy-investigation.v1' || promptLower.includes('discrepancy-investigation.v1')) {
      return {
        schemaVersion: 'discrepancy-investigation.v1',
        validationRunId: 'vrun-test-01',
        clusters: [
          {
            clusterId: 'cluster-missing-attachments',
            name: 'Missing S3 Avatar Attachments',
            category: 'ATTACHMENT_MISSING',
            affectedDiscrepancyIds: ['disc-001', 'disc-002'],
            pattern: 'Attachment files referenced in metadata are absent from S3 target bucket.',
            hypothesisRationale: 'Source S3 bucket sync was interrupted before batch completion.',
            confidence: 0.95,
            recommendedAction: 'Execute allowlisted REUPLOAD_MISSING_ATTACHMENT repair.',
            isProvenFact: false,
          },
          {
            clusterId: 'cluster-duplicate-emails',
            name: 'Non-unique Email Collisions',
            category: 'DUPLICATE_RECORD',
            affectedDiscrepancyIds: ['disc-003'],
            pattern: 'Duplicate email address violates destination unique constraint.',
            hypothesisRationale: 'Source MongoDB collection lacked unique index on email field.',
            confidence: 0.88,
            recommendedAction: 'Review source records and merge duplicate profiles.',
            isProvenFact: true,
          },
        ],
        totalDiscrepanciesAnalyzed: 3,
        clusteredDiscrepancyCount: 3,
        unclusteredCount: 0,
        summary: 'Identified 2 primary failure clusters: 2 missing attachment errors and 1 duplicate record collision.',
      };
    }

    // 3. Repair Proposal
    if (ver === 'repair-proposal.v1' || promptLower.includes('repair-proposal.v1')) {
      return {
        schemaVersion: 'repair-proposal.v1',
        proposalId: 'repair-prop-01',
        operation: 'REPROCESS_RECORDS_WITH_APPROVED_MAPPING',
        scope: {
          validationRunId: 'vrun-test-01',
          discrepancyIds: ['disc-001', 'disc-002'],
          recordKeys: ['cust_01', 'cust_02'],
        },
        mappingVersionId: 'map-v2',
        preconditions: [
          'Mapping version map-v2 passed sample preview test.',
          'Target PostgreSQL connection is reachable.',
        ],
        expectedEffects: [
          'Reprocess records cust_01 and cust_02 using approved mapping map-v2.',
          'Update destination rows without altering unrelated records.',
        ],
        risks: [
          'Overwrites existing destination field values for cust_01 and cust_02 according to write policy.',
        ],
        requiresDryRun: true,
        requiresApproval: true,
      };
    }

    // 4. Copilot Response
    if (ver === 'copilot-response.v1' || promptLower.includes('copilot-response.v1')) {
      return {
        schemaVersion: 'copilot-response.v1',
        answer:
          'The migration run completed with 8,500 records processed and 1,500 records requiring attention. Validation detected 3 discrepancies: 2 missing attachments and 1 duplicate email record.',
        facts: [
          {
            statement: 'Migration run run-01 processed 8,500 records out of 10,000.',
            evidenceRef: {
              type: 'RUN',
              id: 'run-01',
              label: 'Migration Run Counters',
            },
          },
          {
            statement: '2 missing attachment discrepancies were detected by attachment checksum validator.',
            evidenceRef: {
              type: 'DISCREPANCY',
              id: 'disc-001',
              label: 'Attachment Discrepancy Evidence',
            },
          },
        ],
        hypotheses: [
          {
            statement: 'Attachment sync failed due to network timeout during batch-0042.',
            confidence: 0.85,
            basis: 'Sanitized error logs reflect S3 socket timeout during batch-0042.',
          },
        ],
        recommendations: [
          'Review the 2 missing attachments and trigger REUPLOAD_MISSING_ATTACHMENT repair.',
          'Inspect the duplicate email collision in discrepancy explorer.',
        ],
        evidenceRefs: [
          {
            type: 'RUN',
            id: 'run-01',
            label: 'Run Summary',
          },
          {
            type: 'DISCREPANCY',
            id: 'disc-001',
            label: 'Discrepancy disc-001',
          },
        ],
        proposalId: 'prop-suggested-repair-01',
      };
    }

    // 5. Failure Investigation
    if (ver === 'failure-investigation.v1' || promptLower.includes('failure-investigation.v1')) {
      return {
        schemaVersion: 'failure-investigation.v1',
        runId: 'run-test-01',
        errorClassification: 'PERMANENT',
        isPermanent: true,
        hypotheses: [
          {
            id: 'hypo-01',
            hypothesis: 'Malformed timestamp format in legacy records caused PostgreSQL timestamptz parse failure.',
            confidence: 0.91,
            rationale: 'Error logs indicate DATE_PARSE_ERROR on batch batch-0042.',
            affectedBatches: ['batch-0042'],
            affectedRecords: ['cust_101', 'cust_102'],
          },
        ],
        diagnosticSteps: [
          'Inspect raw source records in MongoDB matching IDs cust_101, cust_102.',
          'Verify date format compatibility with PARSE_TIMESTAMP transformer.',
        ],
        suggestedRemediation: 'REPROCESS_RECORDS_WITH_APPROVED_MAPPING',
        requiresHumanReview: true,
      };
    }

    // 6. Transform Suggestion
    if (ver === 'transform-suggestion.v1' || promptLower.includes('transform-suggestion.v1')) {
      return {
        schemaVersion: 'transform-suggestion.v1',
        sourcePath: 'phone_raw',
        destinationPath: 'phone',
        targetType: 'varchar',
        suggestedOperation: 'TRIM_STRING',
        confidence: 0.88,
        rationale: 'Recommended trimming string to fit varchar limit.',
        previewSimulation: {
          sampleInput: '  +1-555-0199  ',
          sampleOutput: '+1-555-0199',
        },
        requiresReview: true,
      };
    }

    // 7. Mapping Proposal
    if (ver === 'mapping-proposal.v1' || promptLower.includes('mapping-proposal.v1')) {
      return {
        schemaVersion: 'mapping-proposal.v1',
        sourceObject: 'customers',
        destinationObject: 'customers',
        proposals: [
          {
            sourcePath: '_id',
            destinationPath: 'source_id',
            transform: { op: 'PRESERVE_SOURCE_ID' },
            confidence: 0.99,
            rationale: 'Primary identifier preservation into destination table.',
            assumptions: ['Unique index on source_id exists in target.'],
            requiresReview: false,
          },
          {
            sourcePath: 'name',
            destinationPath: 'name',
            transform: { op: 'TRIM_STRING' },
            confidence: 0.95,
            rationale: 'Clean trailing/leading whitespace in customer names.',
            assumptions: [],
            requiresReview: false,
          },
          {
            sourcePath: 'createdAt',
            destinationPath: 'created_at',
            transform: { op: 'PARSE_TIMESTAMP', params: { format: 'AUTO_ISO_OR_EPOCH' } },
            confidence: 0.92,
            rationale: 'Convert MongoDB BSON Date or ISO string into timestamptz.',
            assumptions: ['All timestamps are in UTC.'],
            requiresReview: true,
          },
          {
            sourcePath: 'address',
            destinationPath: 'address',
            transform: { op: 'TO_JSONB' },
            confidence: 0.9,
            rationale: 'Preserve nested address object as PostgreSQL JSONB document.',
            assumptions: [],
            requiresReview: false,
          },
        ],
        unresolved: [
          {
            sourcePath: 'orders',
            reason: 'Destination child-table relationship is not defined.',
            question: 'Should each embedded order become a separate row in orders table?',
          },
        ],
        overallConfidence: 0.94,
      };
    }

    // 8. Plan Proposal
    if (ver === 'plan-proposal.v1' || promptLower.includes('plan-proposal.v1') || promptLower.includes('plan') || promptLower.includes('strategy')) {
      return {
        schemaVersion: 'plan-proposal.v1',
        userObjective: 'Migrate MongoDB customers and orders to PostgreSQL',
        sourceConnectionId: 'conn-mongo-staging-01',
        targetConnectionId: 'conn-postgres-prod-01',
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
        assumptions: [
          'Target PostgreSQL schema and tables already exist.',
          'MongoDB _id fields are valid hexadecimal strings or UUIDs.',
        ],
        risks: [
          {
            category: 'INCOMPATIBLE_TYPE',
            description: 'Embedded orders array requires normalization or JSONB storage.',
            severity: 'MEDIUM',
            mitigation: 'Store embedded arrays as JSONB or map to child table.',
          },
        ],
        unresolvedQuestions: [
          'Should embedded orders become separate rows in customer_orders table?',
        ],
        requiresReview: true,
      };
    }

    // Default fallback: Copilot Response
    return {
      schemaVersion: 'copilot-response.v1',
      answer:
        'The migration run completed with 8,500 records processed and 1,500 records requiring attention.',
      facts: [],
      hypotheses: [],
      recommendations: [],
      evidenceRefs: [],
    };
  }
}
