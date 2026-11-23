/**
 * DataMasker - Privacy & Context Minimization Guard
 *
 * Implements FR-AI-005 and 07_AI_AGENT_DESIGN.md Section 8:
 * - Redacts credentials, passwords, tokens, connection strings, and private keys.
 * - Masks PII (emails, phone numbers, credit card numbers, SSNs).
 * - Minimizes data context to schemas, aggregates, and masked samples.
 * - Sanitizes errors and stack traces.
 */

export class DataMasker {
  private static readonly CONNECTION_STRING_REGEX =
    /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/(?:[^:]+):(?:[^@]+)@(?:[^\/\s]+)(?:\/[^\s?]*)?/gi;

  private static readonly PASSWORD_KEY_VALUE_REGEX =
    /(["']?(?:password|passwd|secret|token|apiKey|api_key|access_token|auth|credential|credentials)["']?\s*[:=]\s*["'])([^"'\n\r]+)(["'])/gi;

  private static readonly PRIVATE_KEY_REGEX =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;

  private static readonly BEARER_TOKEN_REGEX =
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

  private static readonly EMAIL_REGEX =
    /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/g;

  private static readonly CREDIT_CARD_REGEX =
    /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

  private static readonly SSN_REGEX =
    /\b\d{3}-\d{2}-\d{4}\b/g;

  private static readonly PHONE_REGEX =
    /(?<![a-zA-Z0-9-])(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

  /**
   * Redact sensitive secrets from any text (prompts, errors, logs).
   */
  public static redactSecrets(text: string): string {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;

    // Redact connection strings
    sanitized = sanitized.replace(
      this.CONNECTION_STRING_REGEX,
      '[REDACTED_CONNECTION_STRING]'
    );

    // Redact private keys
    sanitized = sanitized.replace(
      this.PRIVATE_KEY_REGEX,
      '[REDACTED_PRIVATE_KEY]'
    );

    // Redact bearer tokens
    sanitized = sanitized.replace(
      this.BEARER_TOKEN_REGEX,
      'Bearer [REDACTED_TOKEN]'
    );

    // Redact password key-values
    sanitized = sanitized.replace(
      this.PASSWORD_KEY_VALUE_REGEX,
      '$1[REDACTED_CREDENTIAL]$3'
    );

    return sanitized;
  }

  /**
   * Mask PII in strings: emails, credit cards, SSNs, phone numbers.
   */
  public static maskPII(text: string): string {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;

    // Mask emails: a***b@domain.com
    sanitized = sanitized.replace(this.EMAIL_REGEX, (match, domain) => {
      const user = match.split('@')[0];
      const maskedUser =
        user.length <= 2 ? '**' : `${user[0]}***${user[user.length - 1]}`;
      return `${maskedUser}@${domain}`;
    });

    // Mask Credit Cards
    sanitized = sanitized.replace(this.CREDIT_CARD_REGEX, '****-****-****-****');

    // Mask SSNs
    sanitized = sanitized.replace(this.SSN_REGEX, '***-**-****');

    // Mask Phone numbers
    sanitized = sanitized.replace(this.PHONE_REGEX, '***-***-****');

    return sanitized;
  }

  /**
   * Completely mask text (redact secrets + mask PII).
   */
  public static sanitizeText(text: string): string {
    return this.maskPII(this.redactSecrets(text));
  }

  /**
   * Context Minimization: Ensure a sample record does not contain unmasked production rows.
   * Transforms raw production documents into safe masked samples.
   */
  public static sanitizeSampleRecord(
    record: Record<string, unknown>
  ): Record<string, unknown> {
    if (!record || typeof record !== 'object') return record;

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();

      // Check if key implies secret/credential
      if (
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('key') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('hash') ||
        lowerKey.includes('salt')
      ) {
        result[key] = '[REDACTED_FIELD]';
        continue;
      }

      if (typeof value === 'string') {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          result[key] = value;
        } else {
          result[key] = this.sanitizeText(value);
        }
      } else if (Array.isArray(value)) {
        result[key] = value.slice(0, 3).map((item) =>
          typeof item === 'object' && item !== null
            ? this.sanitizeSampleRecord(item as Record<string, unknown>)
            : typeof item === 'string'
              ? this.sanitizeText(item)
              : item
        );
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.sanitizeSampleRecord(
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Sanitize error message and stack trace.
   */
  public static sanitizeError(error: Error | string): string {
    const raw = typeof error === 'string' ? error : error.stack || error.message;
    // Strip local filesystem file paths for cleanliness
    const withoutPaths = raw.replace(/[A-Za-z]:\\[\w\s\-.\\]+/g, '[INTERNAL_PATH]');
    return this.redactSecrets(withoutPaths);
  }
}
