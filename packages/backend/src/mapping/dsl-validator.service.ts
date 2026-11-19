import { Injectable, BadRequestException } from '@nestjs/common';

export const ALLOWED_TRANSFORM_OPS = [
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
] as const;

export type AllowedTransformOp = (typeof ALLOWED_TRANSFORM_OPS)[number];

export interface ValidationIssue {
  path: string;
  reason: string;
  message: string;
}

@Injectable()
export class DslValidatorService {
  /**
   * Validates a mapping DSL configuration against allowlisted operations and schema constraints
   */
  validateMappingDsl(mappingJson: any): { valid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];

    if (!mappingJson || typeof mappingJson !== 'object') {
      issues.push({
        path: 'root',
        reason: 'INVALID_ROOT',
        message: 'Mapping DSL must be an object.',
      });
      return { valid: false, issues };
    }

    if (!Array.isArray(mappingJson.objects) || mappingJson.objects.length === 0) {
      issues.push({
        path: 'objects',
        reason: 'MISSING_OBJECTS',
        message: 'Mapping DSL must define at least one object mapping.',
      });
      return { valid: false, issues };
    }

    mappingJson.objects.forEach((obj: any, objIdx: number) => {
      const objPath = `objects[${objIdx}]`;
      if (!obj.source || (!obj.source.collection && !obj.source.table)) {
        issues.push({
          path: `${objPath}.source`,
          reason: 'MISSING_SOURCE_OBJECT',
          message: 'Object mapping must define a source collection or table.',
        });
      }
      if (!obj.destination || (!obj.destination.table && !obj.destination.collection)) {
        issues.push({
          path: `${objPath}.destination`,
          reason: 'MISSING_DESTINATION_OBJECT',
          message: 'Object mapping must define a destination table or collection.',
        });
      }

      if (!Array.isArray(obj.fields)) {
        issues.push({
          path: `${objPath}.fields`,
          reason: 'MISSING_FIELDS',
          message: 'Object mapping must define fields array.',
        });
        return;
      }

      obj.fields.forEach((field: any, fieldIdx: number) => {
        const fieldPath = `${objPath}.fields[${fieldIdx}]`;
        if (!field.sourcePath) {
          issues.push({
            path: `${fieldPath}.sourcePath`,
            reason: 'MISSING_SOURCE_PATH',
            message: 'Field mapping requires sourcePath.',
          });
        }
        if (!field.destinationPath) {
          issues.push({
            path: `${fieldPath}.destinationPath`,
            reason: 'MISSING_DESTINATION_PATH',
            message: 'Field mapping requires destinationPath.',
          });
        }

        if (field.transform) {
          const op = field.transform.op;
          if (!ALLOWED_TRANSFORM_OPS.includes(op)) {
            issues.push({
              path: `${fieldPath}.transform.op`,
              reason: 'UNSUPPORTED_OPERATION',
              message: `Transform operation "${op}" is not in the allowlist: ${ALLOWED_TRANSFORM_OPS.join(', ')}`,
            });
          }
        }
      });
    });

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  assertValid(mappingJson: any): void {
    const result = this.validateMappingDsl(mappingJson);
    if (!result.valid) {
      throw new BadRequestException({
        code: 'MAPPING_VALIDATION_FAILED',
        message: 'The mapping contains unsupported conversion operations or invalid syntax.',
        details: result.issues,
      });
    }
  }
}
