import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 'v1';

/**
 * Validates that a string contains valid Unicode per RFC 8785 §3.2.1,
 * rejecting any lone high or low surrogates.
 */
export function validateUnicodeString(str: string, context = 'string'): void {
  // Check fast path if isWellFormed is available in runtime
  if (typeof (str as any).isWellFormed === 'function' && !(str as any).isWellFormed()) {
    throw new TypeError(`Invalid Unicode ${context}: lone surrogate detected`);
  }

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be immediately followed by a low surrogate (0xdc00..0xdfff)
      if (i + 1 >= str.length) {
        throw new TypeError(`Invalid Unicode ${context}: isolated high surrogate at end of string`);
      }
      const nextCode = str.charCodeAt(i + 1);
      if (nextCode < 0xdc00 || nextCode > 0xdfff) {
        throw new TypeError(
          `Invalid Unicode ${context}: high surrogate (0x${code.toString(16)}) not followed by low surrogate at index ${i}`,
        );
      }
      i++; // Skip the paired low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without preceding high surrogate
      throw new TypeError(
        `Invalid Unicode ${context}: isolated low surrogate (0x${code.toString(16)}) at index ${i}`,
      );
    }
  }
}

/**
 * Normalizes any value into a canonical JavaScript structure.
 * Uses active-recursion-path tracking to allow shared non-circular references
 * while strictly rejecting genuine cycles.
 */
export function canonicalizeValue(value: unknown, activePath = new Set<object>()): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Primitive strings: validate Unicode conformance (RFC 8785)
  if (typeof value === 'string') {
    validateUnicodeString(value, 'string value');
    return value;
  }

  // Booleans
  if (typeof value === 'boolean') {
    return value;
  }

  // Numbers: normalize -0 to 0, handle NaN/Infinity
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return 0;
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new TypeError(`Invalid non-finite number in canonicalization: ${value}`);
    }
    return value;
  }

  // BigInt
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Date
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Invalid Date in canonicalization');
    }
    return value.toISOString();
  }

  // Uint8Array or Buffer
  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    return Buffer.from(value as Uint8Array).toString('base64');
  }

  // Objects and Arrays (Active-recursion-path tracking)
  if (typeof value === 'object' && value !== null) {
    if (activePath.has(value)) {
      throw new TypeError('Converting circular structure to JSON');
    }
    activePath.add(value);

    try {
      const obj = value as Record<string, unknown>;

      // Handle Mongo BSON ObjectId or Decimal128 objects
      if (typeof obj.toHexString === 'function') {
        const hex = (obj.toHexString as () => string)();
        validateUnicodeString(hex, 'ObjectId string');
        return hex;
      }
      if (obj._bsontype === 'Decimal128' && typeof obj.toString === 'function') {
        const dec = obj.toString();
        validateUnicodeString(dec, 'Decimal128 string');
        return dec;
      }
      if (obj._bsontype === 'ObjectId' && typeof obj.toString === 'function') {
        const oid = obj.toString();
        validateUnicodeString(oid, 'ObjectId string');
        return oid;
      }

      // Array: preserve element order
      if (Array.isArray(value)) {
        return value.map((item) => canonicalizeValue(item, activePath));
      }

      // Plain or nested Object: validate all property names for Unicode conformance
      const keys = Object.keys(obj);
      for (const k of keys) {
        validateUnicodeString(k, 'property name');
      }

      // Sort keys strictly by UTF-16 code units per RFC 8785 §3.2.3
      const sortedKeys = keys
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const result: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        result[key] = canonicalizeValue(obj[key], activePath);
      }
      return result;
    } finally {
      activePath.delete(value);
    }
  }

  // Ignore functions and symbols
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  return String(value);
}

/**
 * Serializes a value into a deterministic canonical JSON string per RFC 8785.
 * Directly formats object keys in sorted UTF-16 order to avoid JavaScript engine
 * numeric-index property reordering quirks.
 */
export function canonicalizeJson(value: unknown, activePath = new Set<object>()): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    validateUnicodeString(value, 'string value');
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '0';
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new TypeError(`Invalid non-finite number in canonicalization: ${value}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Invalid Date in canonicalization');
    }
    return JSON.stringify(value.toISOString());
  }

  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    return JSON.stringify(Buffer.from(value as Uint8Array).toString('base64'));
  }

  if (typeof value === 'object' && value !== null) {
    if (activePath.has(value)) {
      throw new TypeError('Converting circular structure to JSON');
    }
    activePath.add(value);

    try {
      const obj = value as Record<string, unknown>;

      if (typeof obj.toHexString === 'function') {
        const hex = (obj.toHexString as () => string)();
        validateUnicodeString(hex, 'ObjectId string');
        return JSON.stringify(hex);
      }
      if (obj._bsontype === 'Decimal128' && typeof obj.toString === 'function') {
        const dec = obj.toString();
        validateUnicodeString(dec, 'Decimal128 string');
        return JSON.stringify(dec);
      }
      if (obj._bsontype === 'ObjectId' && typeof obj.toString === 'function') {
        const oid = obj.toString();
        validateUnicodeString(oid, 'ObjectId string');
        return JSON.stringify(oid);
      }

      if (Array.isArray(value)) {
        return '[' + value.map((item) => canonicalizeJson(item, activePath)).join(',') + ']';
      }

      const keys = Object.keys(obj);
      for (const k of keys) {
        validateUnicodeString(k, 'property name');
      }

      const sortedKeys = keys
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const parts: string[] = [];
      for (const k of sortedKeys) {
        parts.push(`${JSON.stringify(k)}:${canonicalizeJson(obj[k], activePath)}`);
      }
      return '{' + parts.join(',') + '}';
    } finally {
      activePath.delete(value);
    }
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }

  return JSON.stringify(String(value));
}

/**
 * Computes a SHA-256 hash of arbitrary string or buffer data.
 * Returns lowercase hex string.
 */
export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data as unknown as string).digest('hex');
}

/**
 * Computes canonical SHA-256 hash formatted as "sha256:<64-hex-chars>".
 */
export function calculateCanonicalHash(value: unknown): string {
  const canonicalJson = canonicalizeJson(value);
  const hash = sha256Hex(canonicalJson);
  return `sha256:${hash}`;
}

/**
 * Computes the canonical hash of a record, with optional exclusion of transient or tracking fields.
 */
export function calculateRecordHash(
  record: Record<string, unknown>,
  options?: { excludeFields?: string[] }
): string {
  if (!options?.excludeFields || options.excludeFields.length === 0) {
    return calculateCanonicalHash(record);
  }

  const filtered: Record<string, unknown> = {};
  const excludeSet = new Set(options.excludeFields);

  for (const [key, val] of Object.entries(record)) {
    if (!excludeSet.has(key)) {
      filtered[key] = val;
    }
  }

  return calculateCanonicalHash(filtered);
}

/**
 * Computes canonical hash of a migration plan version.
 */
export function calculatePlanHash(plan: unknown): string {
  return calculateCanonicalHash(plan);
}

/**
 * Computes canonical hash of a mapping definition.
 */
export function calculateMappingHash(mapping: unknown): string {
  return calculateCanonicalHash(mapping);
}
