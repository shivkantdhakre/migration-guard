/**
 * MigrationGuard Evidence and Audit Sanitizer
 *
 * Ensures evidence dossiers, API traces, logs, and query dumps never expose:
 * 1. Bearer JWT access/refresh tokens
 * 2. Passwords, secrets, and API keys
 * 3. Connection URIs containing plaintext credentials
 */

export interface SanitizerOptions {
  allowlistedFields?: string[];
  maskUrls?: boolean;
}

const SENSITIVE_KEY_PATTERNS = [
  'accesstoken',
  'refreshtoken',
  'token',
  'authorization',
  'password',
  'secret',
  'secret_ref',
  'apikey',
  'privatekey',
  'credentials',
  'clientsecret',
  'connectionstring',
];

// RFC 7519 Base64URL-encoded three-part JWT regex
const JWT_PATTERN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,}$/;
const BEARER_PATTERN = /^Bearer\s+[A-Za-z0-9_.-]+/i;

export function sanitizeEvidence(obj: unknown, options: SanitizerOptions = {}): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeEvidence(item, options));
  }

  if (typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj as Record<string, any>)) {
      const lowerKey = key.toLowerCase();

      // Check for sensitive keys
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pat) => lowerKey === pat || lowerKey.endsWith(pat));

      if (isSensitiveKey) {
        if (typeof val === 'string' && (lowerKey.includes('uri') || lowerKey.includes('url') || lowerKey.includes('connectionstring'))) {
          out[key] = sanitizeUrlCredentials(val);
        } else {
          out[key] = '[REDACTED]';
        }
      } else if (typeof val === 'object' && val !== null) {
        out[key] = sanitizeEvidence(val, options);
      } else if (typeof val === 'string') {
        out[key] = sanitizeString(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  return obj;
}

export function sanitizeString(val: string): string {
  // Check if entire string is a JWT
  if (JWT_PATTERN.test(val.trim())) {
    return '[REDACTED_JWT]';
  }

  // Check for Bearer token
  if (BEARER_PATTERN.test(val.trim())) {
    return 'Bearer [REDACTED_TOKEN]';
  }

  // Sanitize URLs with credentials
  if (val.includes('://') && val.includes('@')) {
    return sanitizeUrlCredentials(val);
  }

  return val;
}

export function sanitizeUrlCredentials(urlStr: string): string {
  return urlStr.replace(/:[^:@]+@/, ':***@');
}

/**
 * Filter an API response using an explicit allowlist of safe fields,
 * and sanitize any residual sensitive keys.
 */
export function filterSafeApiResponse(
  step: string,
  rawResponse: Record<string, any>,
  allowlist?: string[],
): Record<string, any> {
  if (!rawResponse || typeof rawResponse !== 'object') {
    return sanitizeEvidence(rawResponse);
  }

  // If explicit allowlist provided, pick only those fields
  if (allowlist && allowlist.length > 0) {
    const picked: Record<string, any> = {};
    for (const field of allowlist) {
      if (field in rawResponse) {
        picked[field] = sanitizeEvidence(rawResponse[field]);
      }
    }
    return picked;
  }

  // Standard per-step allowlists
  switch (step) {
    case 'Operator Registration':
    case 'Operator Login':
      return {
        user: rawResponse.user
          ? {
              id: rawResponse.user.id,
              email: rawResponse.user.email,
              name: rawResponse.user.name,
            }
          : undefined,
        workspace: rawResponse.workspace
          ? {
              id: rawResponse.workspace.id,
              name: rawResponse.workspace.name,
              slug: rawResponse.workspace.slug,
            }
          : undefined,
        tokenReceived: Boolean(rawResponse.accessToken || rawResponse.token),
        tokenType: 'Bearer',
      };

    case 'Create Project':
      return {
        id: rawResponse.id,
        workspace_id: rawResponse.workspace_id,
        name: rawResponse.name,
        description: rawResponse.description,
        status: rawResponse.status,
      };

    case 'Register Source Connection':
    case 'Register Destination Connection':
      return {
        id: rawResponse.id,
        workspace_id: rawResponse.workspace_id,
        name: rawResponse.name,
        engine: rawResponse.engine,
        connection_role: rawResponse.connection_role,
        config_json: sanitizeEvidence(rawResponse.config_json),
        credential_version: rawResponse.credential_version,
        status: rawResponse.status,
      };

    case 'Create Plan':
      return {
        id: rawResponse.id,
        project_id: rawResponse.project_id,
        name: rawResponse.name,
        status: rawResponse.status,
      };

    case 'Create Plan Version':
      return {
        id: rawResponse.id,
        plan_id: rawResponse.plan_id,
        plan_hash: rawResponse.plan_hash || rawResponse.planHash,
        status: rawResponse.status,
        scope: rawResponse.scope,
      };

    case 'Approve Plan Version':
      return {
        id: rawResponse.id,
        plan_version_id: rawResponse.plan_version_id,
        decision: rawResponse.decision || rawResponse.approval_status,
        approved_at: rawResponse.approved_at,
      };

    case 'Start Migration Run':
      return {
        id: rawResponse.id,
        runId: rawResponse.runId || rawResponse.id,
        plan_version_id: rawResponse.plan_version_id,
        status: rawResponse.status,
      };

    default:
      return sanitizeEvidence(rawResponse);
  }
}
