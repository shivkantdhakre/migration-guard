import {
  TransformConfig,
  RenameTransform,
  TrimStringTransform,
  LowercaseTransform,
  UppercaseTransform,
  ParseIntegerTransform,
  ParseDecimalTransform,
  ParseTimestampTransform,
  ToJsonbTransform,
  FlattenObjectTransform,
  ArrayToChildRowsTransform,
  SetDefaultTransform,
  NullIfEmptyTransform,
  PreserveSourceIdTransform,
  ChildRow,
} from '../types/index.js';

export interface TransformContext {
  record: Record<string, unknown>;
  sourceKey: string;
  sourcePath: string;
  destinationPath: string;
  warnings: string[];
  childRows: ChildRow[];
}

export interface TransformOperationResult {
  value: unknown;
  skipField?: boolean;
}

/**
 * Normalizes BSON values (ObjectId, Date, Decimal128, Binary) into plain JS values
 */
export function normalizeBsonValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.toHexString === 'function') {
      return (obj.toHexString as () => string)();
    }
    if (obj._bsontype === 'Decimal128' && typeof obj.toString === 'function') {
      return obj.toString();
    }
    if (obj._bsontype === 'ObjectId' && typeof obj.toString === 'function') {
      return obj.toString();
    }
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(val))) {
      return Buffer.from(val as unknown as Uint8Array).toString('base64');
    }
    if (Array.isArray(val)) {
      return val.map((item) => normalizeBsonValue(item));
    }
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = normalizeBsonValue(v);
    }
    return res;
  }
  return val;
}

// 1. RENAME
export function applyRename(
  value: unknown,
  _config: RenameTransform,
  _context: TransformContext
): TransformOperationResult {
  return { value };
}

// 2. TRIM_STRING
export function applyTrimString(
  value: unknown,
  config: TrimStringTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value };
  }
  if (typeof value !== 'string') {
    context.warnings.push(`TRIM_STRING: Expected string at "${context.sourcePath}", got ${typeof value}`);
    return { value };
  }
  const mode = config.mode || 'both';
  let res = value;
  if (mode === 'both' || mode === 'left') {
    res = res.trimStart();
  }
  if (mode === 'both' || mode === 'right') {
    res = res.trimEnd();
  }
  return { value: res };
}

// 3. LOWERCASE
export function applyLowercase(
  value: unknown,
  _config: LowercaseTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value };
  }
  if (typeof value !== 'string') {
    context.warnings.push(`LOWERCASE: Expected string at "${context.sourcePath}", got ${typeof value}`);
    return { value };
  }
  return { value: value.toLowerCase() };
}

// 4. UPPERCASE
export function applyUppercase(
  value: unknown,
  _config: UppercaseTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value };
  }
  if (typeof value !== 'string') {
    context.warnings.push(`UPPERCASE: Expected string at "${context.sourcePath}", got ${typeof value}`);
    return { value };
  }
  return { value: value.toUpperCase() };
}

// 5. PARSE_INTEGER
export function applyParseInteger(
  value: unknown,
  config: ParseIntegerTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }
  const radix = config.radix || 10;
  const strict = config.strict ?? false;

  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { value };
    // Float to int
    if (strict) {
      throw new Error(`PARSE_INTEGER: strict mode rejected non-integer number ${value} at "${context.sourcePath}"`);
    }
    context.warnings.push(`PARSE_INTEGER: Truncating float ${value} to integer at "${context.sourcePath}"`);
    return { value: Math.trunc(value) };
  }

  if (typeof value === 'string') {
    let cleanStr = value.trim();
    if (!strict) {
      // Remove thousand separators if standard radix 10
      if (radix === 10) {
        cleanStr = cleanStr.replace(/,/g, '');
      }
    }
    const parsed = parseInt(cleanStr, radix);
    if (Number.isNaN(parsed)) {
      if (strict) {
        throw new Error(`PARSE_INTEGER: Failed to parse "${value}" as integer at "${context.sourcePath}"`);
      }
      context.warnings.push(`PARSE_INTEGER: Invalid integer string "${value}" at "${context.sourcePath}", using fallback`);
      return { value: config.fallback ?? null };
    }
    return { value: parsed };
  }

  if (strict) {
    throw new Error(`PARSE_INTEGER: Unsupported type ${typeof value} at "${context.sourcePath}"`);
  }
  return { value: config.fallback ?? null };
}

// 6. PARSE_DECIMAL
export function applyParseDecimal(
  value: unknown,
  config: ParseDecimalTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }

  let strVal: string;
  if (typeof value === 'number') {
    strVal = value.toString();
  } else if (typeof value === 'string') {
    strVal = value.trim().replace(/,/g, '');
  } else if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toString === 'function') {
      strVal = obj.toString();
    } else {
      strVal = String(value);
    }
  } else {
    strVal = String(value);
  }

  // Validate numeric string format
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(strVal)) {
    if (config.strict) {
      throw new Error(`PARSE_DECIMAL: Invalid decimal string "${strVal}" at "${context.sourcePath}"`);
    }
    context.warnings.push(`PARSE_DECIMAL: Invalid decimal string "${strVal}" at "${context.sourcePath}"`);
    return { value: null };
  }

  // If scale is specified, format fixed-point decimal
  if (config.scale !== undefined && config.scale >= 0) {
    const num = parseFloat(strVal);
    if (Number.isNaN(num)) {
      if (config.strict) {
        throw new Error(`PARSE_DECIMAL: Could not parse "${strVal}" as number`);
      }
      return { value: null };
    }

    const scale = config.scale;
    const factor = Math.pow(10, scale);
    const rounding = config.roundingMode || 'HALF_UP';
    let rounded: number;

    if (rounding === 'FLOOR') {
      rounded = Math.floor(num * factor) / factor;
    } else if (rounding === 'CEIL') {
      rounded = Math.ceil(num * factor) / factor;
    } else if (rounding === 'DOWN') {
      rounded = Math.trunc(num * factor) / factor;
    } else {
      // HALF_UP
      rounded = Math.round(num * factor) / factor;
    }

    const formatted = rounded.toFixed(scale);
    return { value: formatted };
  }

  return { value: strVal };
}

// 7. PARSE_TIMESTAMP
export function applyParseTimestamp(
  value: unknown,
  config: ParseTimestampTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }

  let date: Date;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    // Determine seconds vs milliseconds
    if (value < 10000000000) {
      // Unix seconds (e.g. 1700000000)
      date = new Date(value * 1000);
    } else {
      date = new Date(value);
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Numeric string epoch check
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (num < 10000000000) {
        date = new Date(num * 1000);
      } else {
        date = new Date(num);
      }
    } else {
      date = new Date(trimmed);
    }
  } else if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.$date) {
      if (typeof obj.$date === 'string' || typeof obj.$date === 'number') {
        date = new Date(obj.$date);
      } else if (typeof (obj.$date as Record<string, unknown>).$numberLong === 'string') {
        date = new Date(parseInt((obj.$date as Record<string, unknown>).$numberLong as string, 10));
      } else {
        date = new Date(String(obj.$date));
      }
    } else {
      date = new Date(String(value));
    }
  } else {
    date = new Date(String(value));
  }

  if (Number.isNaN(date.getTime())) {
    context.warnings.push(`PARSE_TIMESTAMP: Invalid timestamp value "${value}" at "${context.sourcePath}"`);
    return { value: null };
  }

  const format = config.format || 'AUTO_ISO_OR_EPOCH';
  if (format === 'EPOCH_MS') {
    return { value: date.getTime() };
  }
  if (format === 'EPOCH_SEC') {
    return { value: Math.floor(date.getTime() / 1000) };
  }

  // Default: ISO 8601 UTC
  return { value: date.toISOString() };
}

// 8. TO_JSONB
export function applyToJsonb(
  value: unknown,
  config: ToJsonbTransform,
  _context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }
  const normalized = normalizeBsonValue(value);
  if (config.pretty) {
    return { value: JSON.stringify(normalized, null, 2) };
  }
  return { value: normalized };
}

// 9. FLATTEN_OBJECT
export function applyFlattenObject(
  value: unknown,
  config: FlattenObjectTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    context.warnings.push(`FLATTEN_OBJECT: Expected object at "${context.sourcePath}", got ${typeof value}`);
    return { value };
  }

  const delimiter = config.delimiter ?? '_';
  const maxDepth = config.maxDepth ?? 5;

  function flatten(
    obj: Record<string, unknown>,
    prefix = '',
    depth = 1
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}${delimiter}${k}` : k;
      if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Date) &&
        depth < maxDepth
      ) {
        Object.assign(
          result,
          flatten(v as Record<string, unknown>, fullKey, depth + 1)
        );
      } else {
        result[fullKey] = normalizeBsonValue(v);
      }
    }
    return result;
  }

  return { value: flatten(value as Record<string, unknown>) };
}

// 10. ARRAY_TO_CHILD_ROWS
export function applyArrayToChildRows(
  value: unknown,
  config: ArrayToChildRowsTransform,
  context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null, skipField: true };
  }
  if (!Array.isArray(value)) {
    context.warnings.push(`ARRAY_TO_CHILD_ROWS: Expected array at "${context.sourcePath}", got ${typeof value}`);
    return { value: null, skipField: true };
  }

  const childTable = config.childTable;
  const parentKeyCol = config.parentKeyCol;
  const itemCol = config.itemCol || 'item_value';
  const itemKeyCol = config.itemKeyCol;
  const indexCol = config.preserveIndexCol;

  value.forEach((item, index) => {
    let payload: Record<string, unknown>;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      payload = { ...normalizeBsonValue(item) as Record<string, unknown> };
      payload[parentKeyCol] = context.sourceKey;
      if (itemKeyCol && !payload[itemKeyCol]) {
        payload[itemKeyCol] = `${context.sourceKey}_${index}`;
      }
    } else {
      payload = {
        [parentKeyCol]: context.sourceKey,
        [itemCol]: normalizeBsonValue(item),
      };
      if (itemKeyCol) {
        payload[itemKeyCol] = `${context.sourceKey}_${index}`;
      }
    }

    if (indexCol) {
      payload[indexCol] = index;
    }

    context.childRows.push({
      destinationTable: childTable,
      parentKey: context.sourceKey,
      parentKeyCol,
      payload,
      sourceIndex: index,
    });
  });

  return { value: null, skipField: true };
}

// 11. SET_DEFAULT
export function applySetDefault(
  value: unknown,
  config: SetDefaultTransform,
  _context: TransformContext
): TransformOperationResult {
  if (value === undefined || value === null) {
    return { value: config.value };
  }
  return { value };
}

// 12. NULL_IF_EMPTY
export function applyNullIfEmpty(
  value: unknown,
  config: NullIfEmptyTransform,
  _context: TransformContext
): TransformOperationResult {
  const checkStrings = config.emptyStrings ?? true;
  const checkObjects = config.emptyObjects ?? false;
  const checkArrays = config.emptyArrays ?? false;

  if (checkStrings && typeof value === 'string' && value.trim() === '') {
    return { value: null };
  }
  if (checkArrays && Array.isArray(value) && value.length === 0) {
    return { value: null };
  }
  if (
    checkObjects &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return { value: null };
  }

  return { value };
}

// 13. PRESERVE_SOURCE_ID
export function applyPreserveSourceId(
  value: unknown,
  config: PreserveSourceIdTransform,
  _context: TransformContext
): TransformOperationResult {
  if (value === null || value === undefined) {
    return { value: null };
  }

  const format = config.format || 'string';

  let normalizedId: string;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toHexString === 'function') {
      normalizedId = (obj.toHexString as () => string)();
    } else if (typeof obj.toString === 'function') {
      normalizedId = obj.toString();
    } else {
      normalizedId = String(value);
    }
  } else {
    normalizedId = String(value);
  }

  if (format === 'hex') {
    normalizedId = normalizedId.toLowerCase().replace(/[^0-9a-f]/g, '');
  }

  return { value: normalizedId };
}

/**
 * Dispatcher function for all allowlisted transform operations
 */
export function executeTransform(
  value: unknown,
  config: TransformConfig,
  context: TransformContext
): TransformOperationResult {
  switch (config.op) {
    case 'RENAME':
      return applyRename(value, config, context);
    case 'TRIM_STRING':
      return applyTrimString(value, config, context);
    case 'LOWERCASE':
      return applyLowercase(value, config, context);
    case 'UPPERCASE':
      return applyUppercase(value, config, context);
    case 'PARSE_INTEGER':
      return applyParseInteger(value, config, context);
    case 'PARSE_DECIMAL':
      return applyParseDecimal(value, config, context);
    case 'PARSE_TIMESTAMP':
      return applyParseTimestamp(value, config, context);
    case 'TO_JSONB':
      return applyToJsonb(value, config, context);
    case 'FLATTEN_OBJECT':
      return applyFlattenObject(value, config, context);
    case 'ARRAY_TO_CHILD_ROWS':
      return applyArrayToChildRows(value, config, context);
    case 'SET_DEFAULT':
      return applySetDefault(value, config, context);
    case 'NULL_IF_EMPTY':
      return applyNullIfEmpty(value, config, context);
    case 'PRESERVE_SOURCE_ID':
      return applyPreserveSourceId(value, config, context);
    default: {
      const exhaustiveCheck: never = config;
      throw new Error(`Unsupported transform operation: ${(exhaustiveCheck as { op: string }).op}`);
    }
  }
}
