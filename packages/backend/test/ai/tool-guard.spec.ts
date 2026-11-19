import { describe, it, expect } from 'vitest';
import { ToolExecutionGuard } from '../../src/ai/tools/tool-guard.js';
import { ToolCatalog } from '../../src/ai/tools/tool-catalog.js';
import { ToolExecutionContext } from '../../src/ai/types.js';

describe('Server-Side Tool Execution Guard (FR-AI-004, FR-AI-002)', () => {
  const engineerContext: ToolExecutionContext = {
    workspaceId: 'ws-prod-01',
    projectId: 'proj-ecommerce-01',
    actorId: 'usr-eng-01',
    actorRole: 'ENGINEER',
  };

  const viewerContext: ToolExecutionContext = {
    workspaceId: 'ws-prod-01',
    projectId: 'proj-ecommerce-01',
    actorId: 'usr-viewer-01',
    actorRole: 'VIEWER',
  };

  it('should allow valid execution of allowlisted read-only tool', async () => {
    const result = await ToolCatalog.executeTool({
      toolName: 'get_connector_capabilities',
      input: { engine: 'POSTGRESQL' },
      context: engineerContext,
    });

    expect(result.success).toBe(true);
    expect((result.data as any)?.engine).toBe('POSTGRESQL');
    expect((result.data as any)?.supportsTransactions).toBe(true);
  });

  it('should strictly block non-allowlisted arbitrary execution tools', async () => {
    const result = await ToolCatalog.executeTool({
      toolName: 'execute_arbitrary_sql', // NOT ALLOWLISTED
      input: { query: 'SELECT * FROM users;' },
      context: engineerContext,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN_TOOL_ACCESS');
    expect(result.error?.message).toContain('Arbitrary SQL, shell commands, or unapproved operations are strictly forbidden');
  });

  it('should block shell execution attempts', async () => {
    const result = await ToolCatalog.executeTool({
      toolName: 'run_bash_command',
      input: { cmd: 'ls -la' },
      context: engineerContext,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN_TOOL_ACCESS');
  });

  it('should enforce role-based access: VIEWER role cannot execute draft proposal tools', async () => {
    const result = await ToolCatalog.executeTool({
      toolName: 'create_draft_proposal',
      input: {
        proposalType: 'PLAN',
        content: { test: true },
        rationale: 'Draft by viewer',
      },
      context: viewerContext, // VIEWER not in ['OWNER', 'ADMIN', 'ENGINEER']
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(result.error?.message).toContain("Role 'VIEWER' is not authorized");
  });

  it('should reject requests without valid workspace context', async () => {
    const invalidContext = {
      workspaceId: '',
      projectId: '',
      actorId: '',
      actorRole: 'ENGINEER' as any,
    };

    const result = await ToolCatalog.executeTool({
      toolName: 'get_connector_capabilities',
      input: { engine: 'POSTGRESQL' },
      context: invalidContext,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNAUTHENTICATED_CONTEXT');
  });

  it('should reject tool input exceeding maximum payload limit', async () => {
    // get_connector_capabilities limit is 64KB
    const giantPayload = 'x'.repeat(70 * 1024);

    const result = await ToolCatalog.executeTool({
      toolName: 'get_connector_capabilities',
      input: { engine: 'POSTGRESQL', extra: giantPayload },
      context: engineerContext,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('should validate tool argument schema and reject malformed inputs', async () => {
    const result = await ToolCatalog.executeTool({
      toolName: 'get_connector_capabilities',
      input: { engine: 'UNSUPPORTED_DATABASE_TYPE' as any },
      context: engineerContext,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TOOL_ARGUMENTS');
  });
});
