import * as crypto from 'crypto';
import { appConfig } from '../../config/configuration';

export interface EncryptedPayload {
  encryptedData: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

export class CryptoUtil {
  private static getKey(): Buffer {
    const rawKey = appConfig.encryptionKey;
    // appConfig.encryptionKey already throws if the env var is missing (P0.2).
    // Here we additionally validate that the key is non-empty.
    if (!rawKey || rawKey.trim() === '') {
      throw new Error('[CryptoUtil] Encryption key is empty. Cannot derive a secure AES key.');
    }
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * Encrypts plaintext data using AES-256-GCM
   */
  public static encrypt(text: string): EncryptedPayload {
    const iv = crypto.randomBytes(12);
    const key = this.getKey();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypts AES-256-GCM ciphertext
   */
  public static decrypt(payload: EncryptedPayload): string {
    const key = this.getKey();
    const iv = Buffer.from(payload.iv, 'hex');
    const authTag = Buffer.from(payload.authTag, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(payload.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Recursively redacts sensitive keys from objects and arrays
   */
  public static redactSecrets<T = any>(obj: T, redactKeys: string[] = appConfig.logRedactKeys): T {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactSecrets(item, redactKeys)) as unknown as T;
    }

    if (typeof obj === 'object') {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        const shouldRedact = redactKeys.some(
          (rk) => lowerKey === rk || lowerKey.includes(rk),
        );

        if (shouldRedact) {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          result[key] = this.redactSecrets(value, redactKeys);
        } else {
          result[key] = value;
        }
      }
      return result as T;
    }

    return obj;
  }

  /**
   * Computes a canonical SHA-256 hash formatted as sha256:<hex>
   * Object keys are recursively sorted to guarantee deterministic hash
   */
  public static canonicalHash(data: any): string {
    const canonicalString = this.canonicalJsonStringify(data);
    const hash = crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
    return `sha256:${hash}`;
  }

  private static canonicalJsonStringify(data: any): string {
    if (data === null || typeof data !== 'object') {
      return JSON.stringify(data);
    }
    if (Array.isArray(data)) {
      return '[' + data.map((item) => this.canonicalJsonStringify(item)).join(',') + ']';
    }
    const keys = Object.keys(data).sort();
    const entries = keys.map(
      (k) => JSON.stringify(k) + ':' + this.canonicalJsonStringify(data[k]),
    );
    return '{' + entries.join(',') + '}';
  }
}
