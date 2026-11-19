import {
  MappingDefinition,
  ObjectMapping,
  FieldMapping,
  TransformConfig,
  SchemaSnapshot,
  TransformOp,
} from '../types/index.js';

export const ALLOWED_TRANSFORM_OPS: ReadonlySet<TransformOp> = new Set<TransformOp>([
  'RENAME',
  'TRIM_STRING',
  'LOWERCASE',
  'UPPERCASE',
  'PARSE_INTEGER',
  'PARSE_DECIMAL',
  'PARSE_TIMESTAMP',
  'TO_JSONB',
  'FLATTEN_OBJECT',
  'ARRAY_TO_CHILD_ROWS',
  'SET_DEFAULT',
  'NULL_IF_EMPTY',
  'PRESERVE_SOURCE_ID',
]);

export interface MappingValidationError {
  path: string;
  code: string;
  message: string;
}

export interface MappingValidationWarning {
  path: string;
  code: string;
  message: string;
}

export interface MappingValidationResult {
  valid: boolean;
  errors: MappingValidationError[];
  warnings: MappingValidationWarning[];
}

/**
 * Validates the syntax, schema structure, and allowlisted operations of a MappingDefinition
 */
export function validateMappingDsl(input: unknown): MappingValidationResult {
  const errors: MappingValidationError[] = [];
  const warnings: MappingValidationWarning[] = [];

  if (!input || typeof input !== 'object') {
    return {
      valid: false,
      errors: [{ path: '', code: 'INVALID_OBJECT', message: 'Mapping must be a non-null object' }],
      warnings: [],
    };
  }

  const mapping = input as Partial<MappingDefinition>;

  // Check version
  if (typeof mapping.version !== 'number' || mapping.version < 1) {
    errors.push({
      path: 'version',
      code: 'INVALID_VERSION',
      message: 'Mapping version must be a positive integer',
    });
  }

  // Check objects array
  if (!Array.isArray(mapping.objects) || mapping.objects.length === 0) {
    errors.push({
      path: 'objects',
      code: 'EMPTY_OBJECTS',
      message: 'Mapping must contain at least one object mapping',
    });
    return { valid: errors.length === 0, errors, warnings };
  }

  // Validate each object mapping
  mapping.objects.forEach((obj, objIdx) => {
    const objPath = `objects[${objIdx}]`;

    if (!obj || typeof obj !== 'object') {
      errors.push({ path: objPath, code: 'INVALID_OBJECT_MAPPING', message: 'Object mapping must be an object' });
      return;
    }

    // Source validation
    if (!obj.source || typeof obj.source !== 'object' || !obj.source.collection || typeof obj.source.collection !== 'string') {
      errors.push({
        path: `${objPath}.source.collection`,
        code: 'MISSING_SOURCE_COLLECTION',
        message: 'Source collection name is required',
      });
    }

    // Destination validation
    if (!obj.destination || typeof obj.destination !== 'object' || !obj.destination.table || typeof obj.destination.table !== 'string') {
      errors.push({
        path: `${objPath}.destination.table`,
        code: 'MISSING_DESTINATION_TABLE',
        message: 'Destination table name is required',
      });
    }

    // Identity validation
    if (!obj.identity || typeof obj.identity !== 'object') {
      errors.push({
        path: `${objPath}.identity`,
        code: 'MISSING_IDENTITY',
        message: 'Identity mapping is required',
      });
    } else {
      if (!obj.identity.sourceKey || typeof obj.identity.sourceKey !== 'string') {
        errors.push({
          path: `${objPath}.identity.sourceKey`,
          code: 'MISSING_SOURCE_KEY',
          message: 'Identity sourceKey is required',
        });
      }
      if (!obj.identity.destinationKey || typeof obj.identity.destinationKey !== 'string') {
        errors.push({
          path: `${objPath}.identity.destinationKey`,
          code: 'MISSING_DESTINATION_KEY',
          message: 'Identity destinationKey is required',
        });
      }
    }

    // Fields validation
    if (!Array.isArray(obj.fields)) {
      errors.push({
        path: `${objPath}.fields`,
        code: 'INVALID_FIELDS',
        message: 'Fields must be an array',
      });
      return;
    }

    const destinationCols = new Set<string>();

    obj.fields.forEach((field, fldIdx) => {
      const fieldPath = `${objPath}.fields[${fldIdx}]`;
      validateFieldMapping(field, fieldPath, errors, warnings, destinationCols);
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateFieldMapping(
  field: FieldMapping,
  fieldPath: string,
  errors: MappingValidationError[],
  warnings: MappingValidationWarning[],
  destinationCols: Set<string>
): void {
  if (!field || typeof field !== 'object') {
    errors.push({ path: fieldPath, code: 'INVALID_FIELD_MAPPING', message: 'Field mapping must be an object' });
    return;
  }

  // Check sourcePath
  if (!field.sourcePath || typeof field.sourcePath !== 'string') {
    errors.push({
      path: `${fieldPath}.sourcePath`,
      code: 'MISSING_SOURCE_PATH',
      message: 'sourcePath is required',
    });
  }

  // Check destinationPath
  if (!field.destinationPath || typeof field.destinationPath !== 'string') {
    errors.push({
      path: `${fieldPath}.destinationPath`,
      code: 'MISSING_DESTINATION_PATH',
      message: 'destinationPath is required',
    });
  } else {
    // Check duplicate destination column collisions (except for nested JSON paths)
    if (!field.destinationPath.includes('.')) {
      if (destinationCols.has(field.destinationPath)) {
        errors.push({
          path: `${fieldPath}.destinationPath`,
          code: 'DUPLICATE_DESTINATION_COLUMN',
          message: `Destination column "${field.destinationPath}" is mapped more than once in this object`,
        });
      } else {
        destinationCols.add(field.destinationPath);
      }
    }
  }

  // Check transform allowlist and config
  if (field.transform) {
    const configs = Array.isArray(field.transform) ? field.transform : [field.transform];
    configs.forEach((cfg, cfgIdx) => {
      const cfgPath = `${fieldPath}.transform${Array.isArray(field.transform) ? `[${cfgIdx}]` : ''}`;
      validateTransformConfig(cfg, cfgPath, errors, warnings);
    });
  }
}

function validateTransformConfig(
  cfg: TransformConfig,
  cfgPath: string,
  errors: MappingValidationError[],
  warnings: MappingValidationWarning[]
): void {
  if (!cfg || typeof cfg !== 'object') {
    errors.push({ path: cfgPath, code: 'INVALID_TRANSFORM', message: 'Transform config must be an object' });
    return;
  }

  // Check for forbidden scripting / code injection keys
  const rawObj = cfg as unknown as Record<string, unknown>;
  const forbiddenKeys = ['code', 'eval', 'script', 'function', 'execute', 'run', 'js', 'sql'];
  for (const k of forbiddenKeys) {
    if (k in rawObj) {
      errors.push({
        path: `${cfgPath}.${k}`,
        code: 'FORBIDDEN_SCRIPT_KEY',
        message: `Arbitrary execution / scripting key "${k}" is strictly prohibited`,
      });
    }
  }

  // Check allowlist
  if (!ALLOWED_TRANSFORM_OPS.has(cfg.op as TransformOp)) {
    errors.push({
      path: `${cfgPath}.op`,
      code: 'UNSUPPORTED_OPERATION',
      message: `Operation "${cfg.op}" is not an allowlisted transformation. Allowed: ${Array.from(ALLOWED_TRANSFORM_OPS).join(', ')}`,
    });
    return;
  }

  // Operation specific parameter validation
  switch (cfg.op) {
    case 'TRIM_STRING': {
      if (cfg.mode && !['both', 'left', 'right'].includes(cfg.mode)) {
        errors.push({
          path: `${cfgPath}.mode`,
          code: 'INVALID_TRIM_MODE',
          message: 'TRIM_STRING mode must be "both", "left", or "right"',
        });
      }
      break;
    }
    case 'PARSE_INTEGER': {
      if (cfg.radix !== undefined) {
        if (!Number.isInteger(cfg.radix) || cfg.radix < 2 || cfg.radix > 36) {
          errors.push({
            path: `${cfgPath}.radix`,
            code: 'INVALID_RADIX',
            message: 'radix must be an integer between 2 and 36',
          });
        }
      }
      break;
    }
    case 'PARSE_DECIMAL': {
      if (cfg.scale !== undefined && (!Number.isInteger(cfg.scale) || cfg.scale < 0)) {
        errors.push({
          path: `${cfgPath}.scale`,
          code: 'INVALID_SCALE',
          message: 'scale must be a non-negative integer',
        });
      }
      if (cfg.roundingMode && !['HALF_UP', 'FLOOR', 'CEIL', 'DOWN'].includes(cfg.roundingMode)) {
        errors.push({
          path: `${cfgPath}.roundingMode`,
          code: 'INVALID_ROUNDING_MODE',
          message: 'roundingMode must be HALF_UP, FLOOR, CEIL, or DOWN',
        });
      }
      break;
    }
    case 'ARRAY_TO_CHILD_ROWS': {
      if (!cfg.childTable || typeof cfg.childTable !== 'string' || cfg.childTable.trim() === '') {
        errors.push({
          path: `${cfgPath}.childTable`,
          code: 'MISSING_CHILD_TABLE',
          message: 'ARRAY_TO_CHILD_ROWS requires a non-empty childTable name',
        });
      }
      if (!cfg.parentKeyCol || typeof cfg.parentKeyCol !== 'string' || cfg.parentKeyCol.trim() === '') {
        errors.push({
          path: `${cfgPath}.parentKeyCol`,
          code: 'MISSING_PARENT_KEY_COL',
          message: 'ARRAY_TO_CHILD_ROWS requires a non-empty parentKeyCol name',
        });
      }
      break;
    }
    case 'SET_DEFAULT': {
      if (cfg.value === undefined) {
        errors.push({
          path: `${cfgPath}.value`,
          code: 'MISSING_DEFAULT_VALUE',
          message: 'SET_DEFAULT requires a value property',
        });
      }
      break;
    }
    case 'PRESERVE_SOURCE_ID': {
      if (cfg.format && !['string', 'hex', 'raw'].includes(cfg.format)) {
        errors.push({
          path: `${cfgPath}.format`,
          code: 'INVALID_FORMAT',
          message: 'PRESERVE_SOURCE_ID format must be "string", "hex", or "raw"',
        });
      }
      break;
    }
  }
}

/**
 * Validates a mapping definition against source and destination schema snapshots.
 */
export function validateMappingAgainstSchemas(
  mapping: MappingDefinition,
  sourceSchema?: SchemaSnapshot,
  destSchema?: SchemaSnapshot
): MappingValidationResult {
  const errors: MappingValidationError[] = [];
  const warnings: MappingValidationWarning[] = [];

  // Validate DSL syntax first
  const dslRes = validateMappingDsl(mapping);
  errors.push(...dslRes.errors);
  warnings.push(...dslRes.warnings);

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  for (let objIdx = 0; objIdx < mapping.objects.length; objIdx++) {
    const objMapping = mapping.objects[objIdx];
    const objPath = `objects[${objIdx}]`;

    // 1. Check Source Schema
    if (sourceSchema) {
      const sourceObj = sourceSchema.objects.find(
        (o) => o.name.toLowerCase() === objMapping.source.collection.toLowerCase()
      );
      if (!sourceObj) {
        warnings.push({
          path: `${objPath}.source.collection`,
          code: 'SOURCE_COLLECTION_NOT_FOUND',
          message: `Collection "${objMapping.source.collection}" was not found in source schema snapshot`,
        });
      } else {
        // Check source fields
        const sourceFieldNames = new Set(sourceObj.fields.map((f) => f.path.toLowerCase()));
        for (const field of objMapping.fields) {
          const baseSource = field.sourcePath.split('.')[0].toLowerCase();
          if (!sourceFieldNames.has(baseSource) && !sourceFieldNames.has(field.sourcePath.toLowerCase())) {
            warnings.push({
              path: `${objPath}.fields["${field.sourcePath}"]`,
              code: 'SOURCE_FIELD_NOT_OBSERVED',
              message: `Source field "${field.sourcePath}" was not observed during schema discovery`,
            });
          }
        }
      }
    }

    // 2. Check Destination Schema
    if (destSchema) {
      const destTable = destSchema.objects.find(
        (o) => o.name.toLowerCase() === objMapping.destination.table.toLowerCase()
      );
      if (!destTable) {
        errors.push({
          path: `${objPath}.destination.table`,
          code: 'DESTINATION_TABLE_NOT_FOUND',
          message: `Table "${objMapping.destination.table}" was not found in destination schema snapshot`,
        });
      } else {
        const destColMap = new Map(destTable.fields.map((f) => [f.name.toLowerCase(), f]));
        const mappedDestCols = new Set<string>();

        // Check each mapped destination column exists
        for (const field of objMapping.fields) {
          // If destinationPath has no dots, it is a table column
          if (!field.destinationPath.includes('.')) {
            const colName = field.destinationPath.toLowerCase();
            mappedDestCols.add(colName);
            if (!destColMap.has(colName)) {
              errors.push({
                path: `${objPath}.fields["${field.destinationPath}"]`,
                code: 'DESTINATION_COLUMN_NOT_FOUND',
                message: `Column "${field.destinationPath}" does not exist in destination table "${objMapping.destination.table}"`,
              });
            }
          }
        }

        // Also check identity destination key
        if (objMapping.identity.destinationKey) {
          mappedDestCols.add(objMapping.identity.destinationKey.toLowerCase());
        }

        // Check for required (not-null without default) target columns that are unmapped
        for (const [colName, colSchema] of destColMap) {
          if (!colSchema.nullable && colSchema.defaultValue === undefined && !colSchema.isPrimaryKey) {
            if (!mappedDestCols.has(colName)) {
              errors.push({
                path: `${objPath}.destination.table`,
                code: 'UNMAPPED_REQUIRED_COLUMN',
                message: `Non-nullable column "${colSchema.name}" in table "${objMapping.destination.table}" has no default value and is not mapped`,
              });
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
