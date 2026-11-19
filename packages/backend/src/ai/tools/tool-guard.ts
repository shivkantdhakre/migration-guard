import { ALLOWLISTED_TOOLS, ToolDefinition } from './allowlist.js';
import { ToolExecutionContext } from '../types.js';
import { DataMasker } from '../masking/data-masker.js';

export interface ToolExecutionRequest {
  toolName: string;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
}

export interface ToolExecutionResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export class ToolExecutionGuard {
  /**
   * Authorize and validate a tool execution request before execution.
   */
  public static validateRequest(
    request: ToolExecutionRequest
  ): { valid: true; definition: ToolDefinition } | { valid: false; error: { code: string; message: string } } {
    const { toolName, input, context } = request;

    // 1. Tool allowlist check
    const definition = ALLOWLISTED_TOOLS[toolName];
    if (!definition) {
      return {
        valid: false,
        error: {
          code: 'FORBIDDEN_TOOL_ACCESS',
          message: `Tool '${toolName}' is not in the allowlisted tool catalog. Arbitrary SQL, shell commands, or unapproved operations are strictly forbidden.`,
        },
      };
    }

    // 2. Workspace and identity context validation
    if (!context || !context.workspaceId || !context.actorId || !context.actorRole) {
      return {
        valid: false,
        error: {
          code: 'UNAUTHENTICATED_CONTEXT',
          message: 'Tool execution requires valid workspaceId, actorId, and actorRole.',
        },
      };
    }

    // 3. Role-based authorization check
    if (!definition.allowedRoles.includes(context.actorRole)) {
      return {
        valid: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: `Role '${context.actorRole}' is not authorized to execute tool '${toolName}'. Allowed roles: ${definition.allowedRoles.join(', ')}`,
        },
      };
    }

    // 4. Payload size check
    const payloadSize = JSON.stringify(input || {}).length;
    if (payloadSize > definition.maxPayloadBytes) {
      return {
        valid: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Tool input size (${payloadSize} bytes) exceeds maximum allowed payload limit (${definition.maxPayloadBytes} bytes).`,
        },
      };
    }

    // 5. Input Schema Validation
    const parseResult = definition.inputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_ARGUMENTS',
          message: `Tool arguments failed schema validation: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        },
      };
    }

    return { valid: true, definition };
  }

  /**
   * Post-process tool execution results to ensure data minimization and secret redaction.
   */
  public static sanitizeToolOutput<T>(output: T): T {
    if (output === null || output === undefined) return output;

    if (typeof output === 'string') {
      return DataMasker.sanitizeText(output) as unknown as T;
    }

    if (typeof output === 'object') {
      return DataMasker.sanitizeSampleRecord(
        output as Record<string, unknown>
      ) as unknown as T;
    }

    return output;
  }
}
