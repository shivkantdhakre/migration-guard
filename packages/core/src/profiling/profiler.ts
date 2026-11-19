import {
  ProfileOptions,
  ProfileResult,
  ObjectProfile,
  FieldProfile,
  PatternObservation,
} from '../types/index.js';
import { normalizeBsonValue } from '../transforms/operations.js';

const COMMON_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ISO_DATE', regex: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/ },
  { name: 'UUID', regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ },
  { name: 'EMAIL', regex: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ },
  { name: 'NUMERIC_STRING', regex: /^-?\d+(\.\d+)?$/ },
  { name: 'JSON_STRING', regex: /^(\s*\{.*\}\s*|\s*\[.*\]\s*)$/s },
  { name: 'OBJECT_ID_HEX', regex: /^[0-9a-fA-F]{24}$/ },
];

/**
 * Detects the granular data type of a value
 */
export function detectType(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) return 'array';
  if (val instanceof Date) return 'date';
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'integer' : 'float';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj._bsontype === 'Decimal128') return 'decimal128';
    if (obj._bsontype === 'ObjectId' || typeof obj.toHexString === 'function') return 'objectId';
    return 'object';
  }
  return typeof val;
}

/**
 * Profiles an array of sample records for a collection or table
 */
export function profileRecords(
  objectName: string,
  records: Array<Record<string, unknown>>,
  options?: ProfileOptions
): ObjectProfile {
  const total = records.length;
  const fieldAccumulators: Record<
    string,
    {
      totalEvaluated: number;
      nullCount: number;
      emptyStringCount: number;
      typeDistribution: Record<string, number>;
      distinctValues: Set<unknown>;
      minNum?: number;
      maxNum?: number;
      minDate?: Date;
      maxDate?: Date;
      totalStrLen: number;
      strCount: number;
      patternMatches: Record<string, number>;
      hasLeadingTrailingWhitespace: boolean;
    }
  > = {};

  const detectPatterns = options?.detectPatterns ?? true;

  function collectFields(obj: Record<string, unknown>, prefix = '', depth = 1): void {
    if (depth > 6) return;
    for (const [k, v] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (!fieldAccumulators[fullPath]) {
        fieldAccumulators[fullPath] = {
          totalEvaluated: 0,
          nullCount: 0,
          emptyStringCount: 0,
          typeDistribution: {},
          distinctValues: new Set(),
          totalStrLen: 0,
          strCount: 0,
          patternMatches: {},
          hasLeadingTrailingWhitespace: false,
        };
      }
      const acc = fieldAccumulators[fullPath];
      acc.totalEvaluated++;

      const normalized = normalizeBsonValue(v);
      const valType = detectType(normalized);
      acc.typeDistribution[valType] = (acc.typeDistribution[valType] || 0) + 1;

      if (normalized === null || normalized === undefined) {
        acc.nullCount++;
      } else {
        // Distinct values (bounded set to max 500 items)
        if (acc.distinctValues.size < 500) {
          if (typeof normalized !== 'object') {
            acc.distinctValues.add(normalized);
          }
        }

        if (typeof normalized === 'string') {
          acc.strCount++;
          acc.totalStrLen += normalized.length;
          if (normalized.trim() === '') {
            acc.emptyStringCount++;
          }
          if (normalized !== normalized.trim()) {
            acc.hasLeadingTrailingWhitespace = true;
          }

          if (detectPatterns) {
            for (const pat of COMMON_PATTERNS) {
              if (pat.regex.test(normalized)) {
                acc.patternMatches[pat.name] = (acc.patternMatches[pat.name] || 0) + 1;
              }
            }
          }
        } else if (typeof normalized === 'number') {
          if (acc.minNum === undefined || normalized < acc.minNum) acc.minNum = normalized;
          if (acc.maxNum === undefined || normalized > acc.maxNum) acc.maxNum = normalized;
        } else if (normalized instanceof Date) {
          if (!acc.minDate || normalized < acc.minDate) acc.minDate = normalized;
          if (!acc.maxDate || normalized > acc.maxDate) acc.maxDate = normalized;
        } else if (typeof normalized === 'object' && !Array.isArray(normalized)) {
          collectFields(normalized as Record<string, unknown>, fullPath, depth + 1);
        }
      }
    }
  }

  // Iterate all records
  for (const record of records) {
    collectFields(record);
  }

  const fields: Record<string, FieldProfile> = {};
  const objectWarnings: string[] = [];

  for (const [path, acc] of Object.entries(fieldAccumulators)) {
    const nullPct = total > 0 ? (acc.nullCount / total) * 100 : 0;
    const warnings: string[] = [];

    // Check for polymorphism
    const nonNullTypes = Object.keys(acc.typeDistribution).filter((t) => t !== 'null' && t !== 'undefined');
    if (nonNullTypes.length > 1) {
      warnings.push(`Polymorphic field: observed multiple distinct types (${nonNullTypes.join(', ')})`);
      objectWarnings.push(`Field "${path}" has polymorphic types: ${nonNullTypes.join(', ')}`);
    }

    if (nullPct > 80 && total > 10) {
      warnings.push(`High null frequency: ${nullPct.toFixed(1)}% of values are null or missing`);
    }

    if (acc.hasLeadingTrailingWhitespace) {
      warnings.push('Contains leading or trailing whitespace; consider TRIM_STRING');
    }

    const patterns: PatternObservation[] = [];
    if (detectPatterns && acc.strCount > 0) {
      for (const [patName, count] of Object.entries(acc.patternMatches)) {
        patterns.push({
          patternName: patName,
          regex: COMMON_PATTERNS.find((p) => p.name === patName)?.regex.source || '',
          matchCount: count,
          matchPercentage: (count / acc.strCount) * 100,
        });
      }
    }

    fields[path] = {
      path,
      totalEvaluated: acc.totalEvaluated,
      nullCount: acc.nullCount,
      nullPercentage: parseFloat(nullPct.toFixed(2)),
      distinctCountEstimate: acc.distinctValues.size,
      emptyStringCount: acc.emptyStringCount > 0 ? acc.emptyStringCount : undefined,
      typeDistribution: acc.typeDistribution,
      min: acc.minNum !== undefined ? acc.minNum : acc.minDate ? acc.minDate.toISOString() : undefined,
      max: acc.maxNum !== undefined ? acc.maxNum : acc.maxDate ? acc.maxDate.toISOString() : undefined,
      avgLength: acc.strCount > 0 ? parseFloat((acc.totalStrLen / acc.strCount).toFixed(2)) : undefined,
      patterns: patterns.length > 0 ? patterns : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  return {
    objectName,
    totalRecordsSampled: total,
    fields,
    warnings: objectWarnings,
    profiledAt: new Date().toISOString(),
  };
}

/**
 * Builds a complete ProfileResult across multiple objects
 */
export function createProfileResult(
  runId: string,
  connectionId: string,
  objectProfiles: ObjectProfile[],
  durationMs: number
): ProfileResult {
  const totalSampled = objectProfiles.reduce((acc, p) => acc + p.totalRecordsSampled, 0);
  return {
    runId,
    connectionId,
    objectProfiles,
    profiledAt: new Date().toISOString(),
    sampleSize: totalSampled,
    durationMs,
  };
}
