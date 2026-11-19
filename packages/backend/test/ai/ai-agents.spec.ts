import { describe, it, expect } from 'vitest';
import { AiService } from '../../src/ai/ai.service.js';
import { MockProvider } from '../../src/ai/providers/mock-provider.js';
import { ToolExecutionContext } from '../../src/ai/types.js';

describe('AI Agents as StateGraph Workflows (07_AI_AGENT_DESIGN.md)', () => {
  const mockProvider = new MockProvider();
  const aiService = new AiService(mockProvider);

  const context: ToolExecutionContext = {
    workspaceId: 'ws-demo-01',
    projectId: 'proj-migration-01',
    actorId: 'usr-engineer-01',
    actorRole: 'ENGINEER',
  };

  it('1. Migration Planner Agent: natural language objective -> structured plan draft', async () => {
    const result = await aiService.draftPlan(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        userObjective: 'Migrate MongoDB customers collection to PostgreSQL with upsert write mode',
        sourceConnectionId: 'conn-mongo-staging',
        targetConnectionId: 'conn-postgres-prod',
      },
      context
    );

    expect(result.status).toBe('NEEDS_INPUT');
    expect(result.proposal).toBeDefined();
    expect(result.proposal?.schemaVersion).toBe('plan-proposal.v1');
    expect(result.proposal?.strategy.batchSize).toBe(1000);
    expect(result.proposal?.strategy.writeMode).toBe('UPSERT_BY_KEY');
    expect(result.proposal?.selectedObjects[0].sourceCollection).toBe('customers');
    expect(result.proposal?.selectedObjects[0].destinationTable).toBe('customers');
    expect(result.proposal?.risks.length).toBeGreaterThan(0);
    expect(result.unresolvedQuestions.length).toBeGreaterThan(0);
    expect(result.toolTraces.length).toBeGreaterThan(0);
  });

  it('2. Schema Mapping Agent: field mapping suggestions with confidence scores and rationale', async () => {
    const result = await aiService.suggestMappings(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        sourceSnapshotId: 'snap-mongo-01',
        targetSnapshotId: 'snap-pg-01',
        sourceObject: 'customers',
        destinationObject: 'customers',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.proposal).toBeDefined();
    expect(result.proposal?.schemaVersion).toBe('mapping-proposal.v1');
    expect(result.proposal?.proposals.length).toBeGreaterThan(0);

    const nameProposal = result.proposal?.proposals.find(
      (p) => p.sourcePath === 'name'
    );
    expect(nameProposal).toBeDefined();
    expect(nameProposal?.transform.op).toBe('TRIM_STRING');
    expect(nameProposal?.confidence).toBeGreaterThan(0.9);

    // Unresolved fields detection
    expect(result.proposal?.unresolved.length).toBeGreaterThan(0);
    expect(result.proposal?.unresolved[0].sourcePath).toBe('orders');
  });

  it('3. Transformation Suggest Agent: ambiguous conversions -> allowlisted deterministic operations', async () => {
    const result = await aiService.transformSuggestAgent.run(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        sourcePath: 'phone_raw',
        destinationPath: 'phone',
        targetType: 'varchar',
        sampleValue: '  +1-555-0199  ',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.suggestion?.schemaVersion).toBe('transform-suggestion.v1');
    expect(result.suggestion?.suggestedOperation).toBe('TRIM_STRING');
    expect(result.suggestion?.previewSimulation).toBeDefined();
  });

  it('4. Risk Assessment Agent: identify lossy transforms, incompatible types, missing constraints', async () => {
    const result = await aiService.assessRisk(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        planVersionId: 'plan-v1',
        sourceSnapshotId: 'snap-01',
        targetSnapshotId: 'snap-02',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.assessment?.schemaVersion).toBe('risk-assessment.v1');
    expect(result.assessment?.findings.length).toBeGreaterThan(0);

    const incompatibleTypeRisk = result.assessment?.findings.find(
      (f) => f.category === 'INCOMPATIBLE_TYPE'
    );
    expect(incompatibleTypeRisk).toBeDefined();
    expect(incompatibleTypeRisk?.severity).toBe('HIGH');
    expect(incompatibleTypeRisk?.isFact).toBe(true);
  });

  it('5. Failure Investigation Agent: analyze failed batches and suggest root causes', async () => {
    const result = await aiService.investigateFailure(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        runId: 'run-test-01',
        batchId: 'batch-0042',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.investigation?.schemaVersion).toBe('failure-investigation.v1');
    expect(result.investigation?.errorClassification).toBe('PERMANENT');
    expect(result.investigation?.hypotheses[0].affectedBatches).toContain('batch-0042');
    expect(result.investigation?.suggestedRemediation).toBe('REPROCESS_RECORDS_WITH_APPROVED_MAPPING');
  });

  it('6. Discrepancy Investigation Agent: cluster validation discrepancies linked to exact discrepancy IDs', async () => {
    const result = await aiService.analyzeDiscrepancies(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        validationRunId: 'vrun-test-01',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.investigation?.schemaVersion).toBe('discrepancy-investigation.v1');
    expect(result.investigation?.clusters.length).toBe(2);

    // Verify exact discrepancy IDs are linked
    const attachmentCluster = result.investigation?.clusters.find(
      (c) => c.category === 'ATTACHMENT_MISSING'
    );
    expect(attachmentCluster).toBeDefined();
    expect(attachmentCluster?.affectedDiscrepancyIds).toEqual(['disc-001', 'disc-002']);

    const duplicateCluster = result.investigation?.clusters.find(
      (c) => c.category === 'DUPLICATE_RECORD'
    );
    expect(duplicateCluster).toBeDefined();
    expect(duplicateCluster?.affectedDiscrepancyIds).toEqual(['disc-003']);
  });

  it('7. Repair Planner Agent: suggest allowlisted repair actions without arbitrary SQL/shell', async () => {
    const result = await aiService.planRepair(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        validationRunId: 'vrun-test-01',
        discrepancyIds: ['disc-001', 'disc-002'],
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.proposal?.schemaVersion).toBe('repair-proposal.v1');
    expect(result.proposal?.operation).toBe('REPROCESS_RECORDS_WITH_APPROVED_MAPPING');
    expect(result.proposal?.requiresDryRun).toBe(true);
    expect(result.proposal?.requiresApproval).toBe(true);
    expect((result.proposal as any).sqlCommand).toBeUndefined();
    expect((result.proposal as any).shellCommand).toBeUndefined();
  });

  it('8. Migration Copilot: natural language Q&A interface citing internal evidence references', async () => {
    const result = await aiService.askCopilot(
      {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        actorId: context.actorId,
        userMessage: 'What is the status of migration run run-01 and why did it fail?',
        runId: 'run-01',
        validationRunId: 'vrun-test-01',
      },
      context
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.response?.schemaVersion).toBe('copilot-response.v1');
    expect(result.response?.answer).toBeDefined();
    expect(result.response?.facts.length).toBeGreaterThan(0);
    expect(result.response?.facts[0].evidenceRef.type).toBe('RUN');
    expect(result.response?.hypotheses.length).toBeGreaterThan(0);
    expect(result.response?.recommendations.length).toBeGreaterThan(0);
  });

  it('9. Accepting proposal creates draft version without mutating approved plan in place', async () => {
    const acceptRes = await aiService.acceptProposal('prop-01', context.actorId);

    expect(acceptRes.status).toBe('ACCEPTED_INTO_DRAFT');
    expect(acceptRes.draftVersionId).toBeDefined();
    expect(acceptRes.acceptedBy).toBe(context.actorId);
  });
});
