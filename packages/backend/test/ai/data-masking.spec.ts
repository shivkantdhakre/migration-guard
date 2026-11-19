import { describe, it, expect } from 'vitest';
import { DataMasker } from '../../src/ai/masking/data-masker.js';

describe('Data Masking & Context Minimization (FR-AI-005, 07_AI_AGENT_DESIGN.md Section 8)', () => {
  it('should redact database connection strings with embedded credentials', () => {
    const textWithMongoUri =
      'Connecting to mongodb://admin:SuperSecretPassword123!@mongo.internal.net:27017/appdb';
    const redacted = DataMasker.redactSecrets(textWithMongoUri);

    expect(redacted).not.toContain('SuperSecretPassword123!');
    expect(redacted).toContain('[REDACTED_CONNECTION_STRING]');

    const textWithPostgres =
      'postgres://pguser:P@ssw0rd!@pg-cluster.internal:5432/migration_db';
    const redactedPg = DataMasker.redactSecrets(textWithPostgres);
    expect(redactedPg).not.toContain('P@ssw0rd!');
    expect(redactedPg).toContain('[REDACTED_CONNECTION_STRING]');
  });

  it('should redact private keys and bearer tokens', () => {
    const rawKey = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3w123456789abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
`.trim();

    const text = `Certificate configured with:\n${rawKey}\nAuthorization: Bearer secret-jwt-token-xyz-123`;
    const redacted = DataMasker.redactSecrets(text);

    expect(redacted).not.toContain('MIIEowIBAAKCAQEA0Y3w123456789');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
    expect(redacted).not.toContain('secret-jwt-token-xyz-123');
    expect(redacted).toContain('Bearer [REDACTED_TOKEN]');
  });

  it('should redact key-value password and secret properties', () => {
    const text = 'Configuration: password = "DatabaseMasterPassword" and token: "api-tok-999"';
    const redacted = DataMasker.redactSecrets(text);

    expect(redacted).not.toContain('DatabaseMasterPassword');
    expect(redacted).not.toContain('api-tok-999');
    expect(redacted).toContain('[REDACTED_CREDENTIAL]');
  });

  it('should mask PII including emails, credit cards, SSNs, and phone numbers', () => {
    const text =
      'Customer contact: john.doe@example.com, card: 4111 2222 3333 4444, ssn: 123-45-6789, phone: +1-555-123-4567';
    const masked = DataMasker.maskPII(text);

    expect(masked).not.toContain('john.doe@example.com');
    expect(masked).toContain('j***e@example.com');
    expect(masked).not.toContain('4111 2222 3333 4444');
    expect(masked).toContain('****-****-****-****');
    expect(masked).not.toContain('123-45-6789');
    expect(masked).toContain('***-**-****');
  });

  it('should sanitize raw sample records into masked samples without credentials or raw PII', () => {
    const rawRecord = {
      _id: '507f1f77bcf86cd799439011',
      username: 'alice_wonder',
      passwordHash: 'argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$Rdesc123',
      secretApiKey: 'sk_live_999999999999',
      email: 'alice@wonderland.corp',
      profile: {
        phone: '555-019-2834',
        creditCard: '5555-4444-3333-2222',
      },
      orders: [
        { id: 'ord-1', total: 100 },
        { id: 'ord-2', total: 200 },
        { id: 'ord-3', total: 300 },
        { id: 'ord-4', total: 400 }, // Bound array slices
      ],
    };

    const sanitized = DataMasker.sanitizeSampleRecord(rawRecord);

    expect(sanitized.passwordHash).toBe('[REDACTED_FIELD]');
    expect(sanitized.secretApiKey).toBe('[REDACTED_FIELD]');
    expect(sanitized.email).toBe('a***e@wonderland.corp');
    expect((sanitized.profile as any).phone).toBe('***-***-****');
    expect((sanitized.profile as any).creditCard).toBe('****-****-****-****');
    // Ensure array is bounded to max 3 items
    expect((sanitized.orders as any[]).length).toBe(3);
  });

  it('should sanitize errors and strip internal filesystem paths', () => {
    const errorWithPaths = new Error(
      'Database connection failed: connect ECONNREFUSED postgres://user:secret@127.0.0.1:5432 at C:\\Projects\\backend\\src\\db.ts:42'
    );
    const sanitized = DataMasker.sanitizeError(errorWithPaths);

    expect(sanitized).not.toContain('secret@');
    expect(sanitized).not.toContain('C:\\Projects\\backend');
    expect(sanitized).toContain('[REDACTED_CONNECTION_STRING]');
    expect(sanitized).toContain('[INTERNAL_PATH]');
  });
});
