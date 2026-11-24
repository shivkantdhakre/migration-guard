import { Injectable } from '@nestjs/common';
import { AllowedTransformOp } from './dsl-validator.service';

@Injectable()
export class MappingPreviewService {
  /**
   * Applies mapping DSL to sample records without destination side-effects
   */
  preview(
    mappingJson: any,
    sampleRecords: any[],
    targetSourceOrObject?: string,
    targetDestination?: string,
  ): any[] {
    const defaultRecords = sampleRecords && sampleRecords.length > 0 ? sampleRecords : this.getDefaultSamples();
    let objectMapping = null;
    const isStrict = process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false';

    if (Array.isArray(mappingJson?.objects)) {
      if (targetSourceOrObject && targetDestination) {
        // Exact source AND destination matching (Finding 7)
        const matches = mappingJson.objects.filter(
          (o: any) =>
            ((o.source?.collection || o.source?.object || o.sourceObject || o.source) === targetSourceOrObject) &&
            ((o.destination?.table || o.destination?.object || o.destinationObject || o.destination) === targetDestination),
        );
        if (matches.length > 1) {
          throw new Error(
            `Ambiguous mapping: multiple approved objects match source '${targetSourceOrObject}' and destination '${targetDestination}'.`,
          );
        }
        objectMapping = matches.length === 1 ? matches[0] : null;
      } else if (targetSourceOrObject) {
        // Target specified: require exact match; do not silently fall back to unrelated single-mapping
        const matches = mappingJson.objects.filter(
          (o: any) =>
            ((o.source?.collection || o.source?.object || o.sourceObject || o.source) === targetSourceOrObject) &&
            ((o.destination?.table || o.destination?.object || o.destinationObject || o.destination) === targetSourceOrObject),
        );
        const candidateMatches = matches.length === 1 ? matches : mappingJson.objects.filter(
          (o: any) =>
            ((o.source?.collection || o.source?.object || o.sourceObject || o.source) === targetSourceOrObject) ||
            ((o.destination?.table || o.destination?.object || o.destinationObject || o.destination) === targetSourceOrObject),
        );
        if (candidateMatches.length > 1 && isStrict) {
          throw new Error(
            `Ambiguous mapping: multiple approved objects match target '${targetSourceOrObject}'.`,
          );
        }
        objectMapping = candidateMatches.length === 1 ? candidateMatches[0] : null;
      } else if (!targetSourceOrObject && !targetDestination) {
        if (mappingJson.objects.length === 1) {
          objectMapping = mappingJson.objects[0];
        }
      }
    } else if (mappingJson?.source && mappingJson?.destination) {
      if (targetSourceOrObject && targetDestination) {
        const sMatch = (mappingJson.source?.collection || mappingJson.source?.object || mappingJson.sourceObject || mappingJson.source) === targetSourceOrObject;
        const dMatch = (mappingJson.destination?.table || mappingJson.destination?.object || mappingJson.destinationObject || mappingJson.destination) === targetDestination;
        if (sMatch && dMatch) {
          objectMapping = mappingJson;
        }
      } else if (targetSourceOrObject) {
        const sMatch = (mappingJson.source?.collection || mappingJson.source?.object || mappingJson.sourceObject || mappingJson.source) === targetSourceOrObject;
        const dMatch = (mappingJson.destination?.table || mappingJson.destination?.object || mappingJson.destinationObject || mappingJson.destination) === targetSourceOrObject;
        if (sMatch || dMatch) {
          objectMapping = mappingJson;
        }
      } else {
        objectMapping = mappingJson;
      }
    }

    if (!objectMapping) return [];

    return defaultRecords.map((sourceRecord) => {
      const transformedRecord: Record<string, any> = {};

      // Identity mapping
      if (objectMapping.identity) {
        const { sourceKey, destinationKey, strategy } = objectMapping.identity;
        const rawKey = sourceRecord[sourceKey];
        transformedRecord[destinationKey] =
          strategy === 'PRESERVE_AS_TEXT' ? String(rawKey) : rawKey;
      }

      // Field transformations
      for (const field of objectMapping.fields || []) {
        const sourceVal = this.getByPath(sourceRecord, field.sourcePath);
        const transformedVal = this.applyTransform(sourceVal, field.transform);
        this.setByPath(transformedRecord, field.destinationPath, transformedVal);
      }

      return {
        sourceRecord,
        transformedRecord,
      };
    });
  }

  private applyTransform(val: any, transform?: { op: AllowedTransformOp; [key: string]: any }): any {
    if (!transform || !transform.op) return val;

    switch (transform.op) {
      case 'RENAME':
        return val;
      case 'TRIM_STRING':
        return typeof val === 'string' ? val.trim() : val;
      case 'LOWERCASE':
        return typeof val === 'string' ? val.toLowerCase() : val;
      case 'UPPERCASE':
        return typeof val === 'string' ? val.toUpperCase() : val;
      case 'PARSE_INTEGER':
        return parseInt(String(val), 10);
      case 'PARSE_DECIMAL':
        return parseFloat(String(val));
      case 'PARSE_TIMESTAMP':
        if (!val) return null;
        return new Date(val).toISOString();
      case 'TO_JSONB':
        return val !== undefined ? val : null;
      case 'FLATTEN_OBJECT':
        return typeof val === 'object' && val !== null ? JSON.stringify(val) : val;
      case 'SET_DEFAULT':
        return val === undefined || val === null ? transform.defaultValue : val;
      case 'NULL_IF_EMPTY':
        return val === '' ? null : val;
      case 'PRESERVE_SOURCE_ID':
        return String(val);
      default:
        return val;
    }
  }

  private getByPath(obj: any, path: string): any {
    if (!obj || !path) return undefined;
    const parts = path.split('.');
    let curr = obj;
    for (const p of parts) {
      if (curr === null || curr === undefined) return undefined;
      curr = curr[p];
    }
    return curr;
  }

  private setByPath(obj: any, path: string, val: any): void {
    if (!obj || !path) return;
    const parts = path.split('.');
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!curr[p] || typeof curr[p] !== 'object') {
        curr[p] = {};
      }
      curr = curr[p];
    }
    curr[parts[parts.length - 1]] = val;
  }

  private getDefaultSamples(): any[] {
    return [
      {
        _id: '673c1d9b0000000000000001',
        name: '  Acme Corporation  ',
        email: 'INFO@ACME.COM',
        createdAt: '2026-11-19T10:00:00.000Z',
        address: { street: '123 Tech Blvd', city: 'Metropolis', zip: '10001' },
      },
      {
        _id: '673c1d9b0000000000000002',
        name: 'Globex Ltd',
        email: 'SUPPORT@GLOBEX.ORG',
        createdAt: '2026-11-19T11:30:00.000Z',
        address: { street: '456 Innovation Way', city: 'Gotham', zip: '20002' },
      },
    ];
  }
}
