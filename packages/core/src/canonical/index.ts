import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 'v1';

/**
 * Normalizes any value into a canonical representation compliant with RFC 8785 (JSON Canonicalization Scheme)
 * with extensions for Date, Decimal, BigInt, and Binary/Buffer types.
 */
export function canonicalizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Primitive strings, booleans
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  // Numbers: normalize -0 to 0, handle NaN/Infinity
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return 0;
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new Error(`Invalid non-finite number in canonicalization: ${value}`);
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
      throw new Error('Invalid Date in canonicalization');
    }
    return value.toISOString();
  }

  // Uint8Array or Buffer
  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    return Buffer.from(value as Uint8Array).toString('base64');
  }

  // Handle Mongo BSON ObjectId or Decimal128 objects with toHexString() or toString()
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      throw new Error('Circular reference detected in canonicalization');
    }
    seen.add(value);

    const obj = value as Record<string, unknown>;
    if (typeof obj.toHexString === 'function') {
      return (obj.toHexString as () => string)();
    }
    if (obj._bsontype === 'Decimal128' && typeof obj.toString === 'function') {
      return obj.toString();
    }
    if (obj._bsontype === 'ObjectId' && typeof obj.toString === 'function') {
      return obj.toString();
    }

    // Array
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeValue(item, seen));
    }

    // Plain or nested Object: sort keys strictly by UTF-16 code unit
    const sortedKeys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue(obj[key], seen);
    }
    return result;
  }

  // Ignore functions and symbols
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  return String(value);
}

/**
 * Serializes a value into a deterministic canonical JSON string.
 */
export function canonicalizeJson(value: unknown): string {
  const normalized = canonicalizeValue(value);
  return JSON.stringify(normalized);
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
