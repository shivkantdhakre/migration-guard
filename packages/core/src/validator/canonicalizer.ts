import { createHash } from 'node:crypto';
import { canonicalizeJson, validateUnicodeString, sha256Hex } from '../canonical/index.js';

/**
 * Deterministic canonicalization and SHA-256 hashing utility
 * following MigrationGuard canonicalization specs in 08_MIGRATION_ENGINE_DESIGN.md.
 */

export interface CanonicalizeOptions {
  /** If true, array items will be sorted if they are primitives or have an `id` */
  sortArrays?: boolean;
  /** Exclude specific top-level or dotted paths (e.g., volatile fields like extractedAt) */
  excludeFields?: string[];
}

/**
 * Recursively canonicalizes any JS value into a stable, deterministic representation.
 */
export function canonicalizeValue(val: unknown, options: CanonicalizeOptions = {}): unknown {
  if (val === null || val === undefined) {
    return null;
  }

  if (val instanceof Date) {
    return val.toISOString();
  }

  if (typeof val === 'string') {
    validateUnicodeString(val, 'validator string');
    return val;
  }

  if (typeof val === 'number') {
    // Normalize -0 to 0, handle NaN/Infinity
    if (Object.is(val, -0)) return 0;
    if (Number.isNaN(val)) return 'NaN';
    if (!Number.isFinite(val)) return val > 0 ? 'Infinity' : '-Infinity';
    return val;
  }

  if (typeof val === 'boolean') {
    return val;
  }

  if (Array.isArray(val)) {
    const canonicalArray = val.map((item) => canonicalizeValue(item, options));
    if (options.sortArrays) {
      return [...canonicalArray].sort((a, b) => {
        const strA = JSON.stringify(a);
        const strB = JSON.stringify(b);
        return strA.localeCompare(strB);
      });
    }
    return canonicalArray;
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const sortedObj: Record<string, unknown> = {};

    for (const key of keys) {
      if (options.excludeFields && options.excludeFields.includes(key)) {
        continue;
      }
      const propVal = (val as Record<string, unknown>)[key];
      // Canonicalize nested value
      sortedObj[key] = canonicalizeValue(propVal, options);
    }
    return sortedObj;
  }

  return String(val);
}

/**
 * Serializes canonicalized representation to stable JSON string using RFC 8785 rules.
 */
export function canonicalizeToJson(val: unknown, options: CanonicalizeOptions = {}): string {
  const canonical = canonicalizeValue(val, options);
  return canonicalizeJson(canonical);
}

/**
 * Computes deterministic SHA-256 content hash of any data representation.
 */
export function computeCanonicalHash(val: unknown, options: CanonicalizeOptions = {}): string {
  const json = canonicalizeToJson(val, options);
  return sha256Hex(json);
}
