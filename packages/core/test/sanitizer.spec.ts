import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSafeApiResponse,
  sanitizeEvidence,
  sanitizeString,
  sanitizeUrlCredentials,
} from '../dist/utils/sanitizer.js';

describe('Sanitizer & Evidence Redaction Utility (P0.2)', () => {
  it('redacts RFC 7519 JWT strings', () => {
    const rawJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const sanitized = sanitizeString(rawJwt);
    assert.equal(sanitized, '[REDACTED_JWT]');
    assert.equal(sanitized.includes('eyJ'), false);
  });

  it('redacts Bearer tokens in authorization headers', () => {
    const authHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token.signature';
    const sanitized = sanitizeString(authHeader);
    assert.equal(sanitized, 'Bearer [REDACTED_TOKEN]');
    assert.equal(sanitized.includes('eyJ'), false);
  });

  it('masks plaintext credentials in connection strings', () => {
    const connStr = 'postgresql://admin_user:super_secret_password123@db.example.com:5432/mydb?sslmode=require';
    const sanitized = sanitizeUrlCredentials(connStr);
    assert.equal(sanitized, 'postgresql://admin_user:***@db.example.com:5432/mydb?sslmode=require');
    assert.equal(sanitized.includes('super_secret_password123'), false);
  });

  it('redacts sensitive keys in deeply nested objects and arrays', () => {
    const payload = {
      user: {
        id: 'usr_001',
        email: 'operator@example.com',
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        credentials: {
          password: 'SecretPassword99!',
          apiKey: 'key_live_1234567890abcdef',
        },
        profile: {
          apiKey: 'key_live_1234567890abcdef',
          password: 'SecretPassword99!',
        },
      },
      connections: [
        {
          name: 'PostgreSQL DB',
          connectionString: 'postgresql://usr:pass@host:5432/db',
          token: 'token123',
        },
        {
          name: 'Redis',
          uri: 'rediss://default:redis_pass@host:6379',
        },
      ],
      metadata: {
        safeField: 'Hello World',
      },
    };

    const sanitized = sanitizeEvidence(payload);

    assert.equal(sanitized.user.id, 'usr_001');
    assert.equal(sanitized.user.email, 'operator@example.com');
    assert.equal(sanitized.user.accessToken, '[REDACTED]');
    assert.equal(sanitized.user.credentials, '[REDACTED]');
    assert.equal(sanitized.user.profile.apiKey, '[REDACTED]');
    assert.equal(sanitized.user.profile.password, '[REDACTED]');
    assert.equal(sanitized.connections[0].connectionString, 'postgresql://usr:***@host:5432/db');
    assert.equal(sanitized.connections[0].token, '[REDACTED]');
    assert.equal(sanitized.connections[1].uri, 'rediss://default:***@host:6379');
    assert.equal(sanitized.metadata.safeField, 'Hello World');

    // Ensure raw strings never leak into serialized JSON
    const serialized = JSON.stringify(sanitized);
    assert.equal(serialized.includes('SecretPassword99!'), false);
    assert.equal(serialized.includes('key_live_1234567890abcdef'), false);
    assert.equal(serialized.includes('redis_pass'), false);
    assert.equal(serialized.includes('eyJ'), false);
  });

  it('filters API responses using strict safe allowlists', () => {
    const registrationResponse = {
      user: {
        id: 'usr_abc',
        email: 'test@migrationguard.io',
        name: 'Test Operator',
        passwordHash: '$2b$10$hashed_secret',
      },
      workspace: {
        id: 'ws_123',
        name: 'Test Workspace',
        slug: 'test-ws',
      },
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token.sig',
      refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.sig',
    };

    const filtered = filterSafeApiResponse('Operator Registration', registrationResponse);

    assert.equal(filtered.user.id, 'usr_abc');
    assert.equal(filtered.user.email, 'test@migrationguard.io');
    assert.equal(filtered.user.passwordHash, undefined);
    assert.equal(filtered.workspace.id, 'ws_123');
    assert.equal(filtered.accessToken, undefined);
    assert.equal(filtered.refreshToken, undefined);
    assert.equal(filtered.tokenReceived, true);
    assert.equal(filtered.tokenType, 'Bearer');
  });
});
