import {
  ObjectMapping,
  SourceRecordEnvelope,
  TransformedRecord,
  ChildRow,
  IdentityStrategy,
} from '../types/index.js';
import { executeTransform, normalizeBsonValue, TransformContext } from './operations.js';
import { calculateRecordHash, sha256Hex } from '../canonical/index.js';

/**
 * Extracts a value from a nested object using dot-notation ("address.city")
 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path || path === '') return obj;
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Sets a value on a nested object using dot-notation ("address.city")
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || current[part] === null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

/**
 * Resolves source identity to destination identity based on strategy
 */
export function resolveDestinationKey(
  sourceKey: string,
  strategy: IdentityStrategy
): string {
  switch (strategy) {
    case 'PRESERVE_AS_TEXT':
    case 'PRESERVE_ORIGINAL':
      return String(sourceKey);
    case 'HASH_SHA256':
      return sha256Hex(String(sourceKey));
    case 'MAP_TO_UUID': {
      // Deterministic UUID-like representation from source key hash
      const hash = sha256Hex(String(sourceKey));
      return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-a${hash.substring(17, 20)}-${hash.substring(20, 32)}`;
    }
    case 'CUSTOM':
    default:
      return String(sourceKey);
  }
}

/**
 * Deterministic Transformation Engine
 */
export class TransformationEngine {
  private mapping: ObjectMapping;

  constructor(mapping: ObjectMapping) {
    this.mapping = mapping;
  }

  /**
   * Transforms a single source envelope or raw source record into a TransformedRecord
   */
  public transform(
    input: SourceRecordEnvelope | Record<string, unknown>
  ): TransformedRecord {
    const rawPayload: Record<string, unknown> =
      'payload' in input && typeof input.payload === 'object' && input.payload !== null
        ? (input.payload as Record<string, unknown>)
        : (input as Record<string, unknown>);

    const rawIdVal = getByPath(rawPayload, this.mapping.identity.sourceKey);
    const normalizedIdVal = normalizeBsonValue(rawIdVal);
    const rawSourceKey =
      'sourceKey' in input && input.sourceKey
        ? String(input.sourceKey)
        : String(normalizedIdVal ?? 'unknown_id');

    const sourceObject =
      'sourceObject' in input && typeof input.sourceObject === 'string'
        ? input.sourceObject
        : this.mapping.source.collection;

    const destinationObject = this.mapping.destination.schema
      ? `${this.mapping.destination.schema}.${this.mapping.destination.table}`
      : this.mapping.destination.table;

    // Derive clean business ID from mapped source value, stripping any internal type prefix if fallback is needed
    const businessKeyStr =
      normalizedIdVal !== undefined && normalizedIdVal !== null
        ? String(normalizedIdVal)
        : (rawSourceKey.includes(':')
            ? rawSourceKey.substring(rawSourceKey.indexOf(':') + 1)
            : rawSourceKey);

    const destinationKey = resolveDestinationKey(
      businessKeyStr,
      this.mapping.identity.strategy
    );

    const warnings: string[] = [];
    const childRows: ChildRow[] = [];
    const destinationPayload: Record<string, unknown> = {};

    // Process each field mapping
    for (const field of this.mapping.fields) {
      const context: TransformContext = {
        record: rawPayload,
        sourceKey: rawSourceKey,
        sourcePath: field.sourcePath,
        destinationPath: field.destinationPath,
        warnings,
        childRows,
      };

      const rawVal = getByPath(rawPayload, field.sourcePath);
      let currentVal = normalizeBsonValue(rawVal);

      // Handle null/undefined with default value if provided
      if ((currentVal === undefined || currentVal === null) && field.defaultValue !== undefined) {
        currentVal = field.defaultValue;
      }

      let skipField = false;

      // Apply transforms
      if (field.transform) {
        const configs = Array.isArray(field.transform) ? field.transform : [field.transform];
        for (const cfg of configs) {
          const res = executeTransform(currentVal, cfg, context);
          currentVal = res.value;
          if (res.skipField) {
            skipField = true;
            break;
          }
        }
      }

      if (!skipField) {
        // Enforce nullability check
        if (field.nullable === false && (currentVal === null || currentVal === undefined)) {
          warnings.push(`Non-nullable field "${field.destinationPath}" received null/undefined from source "${field.sourcePath}"`);
        }

        // Assign to destination payload
        if (field.destinationPath.includes('.')) {
          setByPath(destinationPayload, field.destinationPath, currentVal);
        } else {
          destinationPayload[field.destinationPath] = currentVal;
        }
      }
    }

    // Always enforce the resolved destination identity key
    if (this.mapping.identity.destinationKey) {
      destinationPayload[this.mapping.identity.destinationKey] = destinationKey;
    }

    // Compute canonical hash of the transformed payload
    const canonicalHash = calculateRecordHash(destinationPayload);

    return {
      destinationObject,
      destinationKey,
      sourceObject,
      sourceKey: rawSourceKey,
      payload: destinationPayload,
      childRows: childRows.length > 0 ? childRows : undefined,
      canonicalHash,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Transforms an array of source envelopes/records
   */
  public transformBatch(
    inputs: Array<SourceRecordEnvelope | Record<string, unknown>>
  ): TransformedRecord[] {
    return inputs.map((item) => this.transform(item));
  }
}
