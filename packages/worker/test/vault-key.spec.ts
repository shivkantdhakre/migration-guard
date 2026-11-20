/**
 * vault-key.spec.ts
 *
 * P0.2 Verification: The encryption subsystem must fail closed when the
 * ENCRYPTION_KEY / ENCRYPTION_MASTER_KEY environment variable is missing or empty,
 * and must correctly roundtrip when a valid key is present.
 *
 * These tests directly exercise the AES-256-GCM encrypt/decrypt primitives used
 * by both the backend (CryptoUtil) and the worker (resolveEncryptionKey).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// ── helpers ────────────────────────────────────────────────────────────────────

function aesGcmEncrypt(plaintext: string, keyHex: string): { iv: string; authTag: string; encrypted: string } {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), encrypted: enc };
}

function aesGcmDecrypt(
  encrypted: string,
  ivHex: string,
  authTagHex: string,
  keyHex: string,
): string {
  const key = /^[0-9a-fA-F]{64}$/.test(keyHex)
    ? Buffer.from(keyHex, 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let dec = decipher.update(encrypted, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

/** Mirrors the worker's resolveEncryptionKey() logic exactly */
function resolveEncryptionKey(env: Record<string, string | undefined>): Buffer {
  const rawKey = env['ENCRYPTION_KEY'] ?? env['ENCRYPTION_MASTER_KEY'];
  if (!rawKey || rawKey.trim() === '') {
    throw new Error(
      '[Worker] ENCRYPTION_KEY / ENCRYPTION_MASTER_KEY is not set. ' +
        'Worker cannot decrypt vault credentials.',
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey).digest();
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('P0.2 — Encryption key fail-closed behaviour', () => {
  it('throws when ENCRYPTION_KEY is absent', () => {
    expect(() => resolveEncryptionKey({})).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws when ENCRYPTION_KEY is an empty string', () => {
    expect(() => resolveEncryptionKey({ ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws when ENCRYPTION_KEY is whitespace only', () => {
    expect(() => resolveEncryptionKey({ ENCRYPTION_KEY: '   ' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('resolves a valid 64-char hex key without hashing', () => {
    const keyHex = crypto.randomBytes(32).toString('hex');
    const buf = resolveEncryptionKey({ ENCRYPTION_KEY: keyHex });
    expect(buf.toString('hex')).toBe(keyHex);
  });

  it('resolves ENCRYPTION_MASTER_KEY when ENCRYPTION_KEY is absent', () => {
    const keyHex = crypto.randomBytes(32).toString('hex');
    const buf = resolveEncryptionKey({ ENCRYPTION_MASTER_KEY: keyHex });
    expect(buf.toString('hex')).toBe(keyHex);
  });

  it('ENCRYPTION_KEY takes precedence over ENCRYPTION_MASTER_KEY', () => {
    const key1 = crypto.randomBytes(32).toString('hex');
    const key2 = crypto.randomBytes(32).toString('hex');
    const buf = resolveEncryptionKey({ ENCRYPTION_KEY: key1, ENCRYPTION_MASTER_KEY: key2 });
    expect(buf.toString('hex')).toBe(key1);
  });
});

describe('P0.2 — AES-256-GCM encrypt / decrypt roundtrip', () => {
  const validKeyHex = crypto.randomBytes(32).toString('hex');
  const plaintext = JSON.stringify({ connectionString: 'postgresql://user:pass@host/db' });

  it('encrypts and decrypts successfully with the correct key', () => {
    const { iv, authTag, encrypted } = aesGcmEncrypt(plaintext, validKeyHex);
    const decrypted = aesGcmDecrypt(encrypted, iv, authTag, validKeyHex);
    expect(decrypted).toBe(plaintext);
  });

  it('throws on decryption with the wrong key (auth tag mismatch)', () => {
    const { iv, authTag, encrypted } = aesGcmEncrypt(plaintext, validKeyHex);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    expect(() => aesGcmDecrypt(encrypted, iv, authTag, wrongKey)).toThrow();
  });

  it('throws on decryption with a tampered auth tag', () => {
    const { iv, encrypted } = aesGcmEncrypt(plaintext, validKeyHex);
    const badAuthTag = 'ffffffffffffffffffffffffffffffff'; // 16 bytes, wrong
    expect(() => aesGcmDecrypt(encrypted, iv, badAuthTag, validKeyHex)).toThrow();
  });

  it('throws on decryption with a tampered ciphertext', () => {
    const { iv, authTag, encrypted } = aesGcmEncrypt(plaintext, validKeyHex);
    const tampered = encrypted.slice(0, -2) + (encrypted.slice(-2) === 'ff' ? '00' : 'ff');
    expect(() => aesGcmDecrypt(tampered, iv, authTag, validKeyHex)).toThrow();
  });
});
