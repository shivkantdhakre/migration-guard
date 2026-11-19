import { describe, it, expect, beforeEach } from 'vitest';
import { DslValidatorService } from '../src/mapping/dsl-validator.service';
import { MappingPreviewService } from '../src/mapping/mapping-preview.service';
import { MappingService } from '../src/mapping/mapping.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('Mapping DSL & Sample Preview', () => {
  let dslValidator: DslValidatorService;
  let previewService: MappingPreviewService;
  let mappingService: MappingService;
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let authService: AuthService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    dslValidator = new DslValidatorService();
    previewService = new MappingPreviewService();
    mappingService = new MappingService(db, workspaceService, dslValidator, previewService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);
  });

  it('should accept allowlisted deterministic operations in mapping DSL', () => {
    const validDsl = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'source_id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
            { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
            { sourcePath: 'code', destinationPath: 'code', transform: { op: 'UPPERCASE' } },
            { sourcePath: 'age', destinationPath: 'age', transform: { op: 'PARSE_INTEGER' } },
            { sourcePath: 'price', destinationPath: 'price', transform: { op: 'PARSE_DECIMAL' } },
            { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
            { sourcePath: 'metadata', destinationPath: 'metadata', transform: { op: 'TO_JSONB' } },
            { sourcePath: 'settings', destinationPath: 'settings_str', transform: { op: 'FLATTEN_OBJECT' } },
            { sourcePath: 'active', destinationPath: 'is_active', transform: { op: 'SET_DEFAULT', defaultValue: true } },
            { sourcePath: 'notes', destinationPath: 'notes', transform: { op: 'NULL_IF_EMPTY' } },
            { sourcePath: 'externalId', destinationPath: 'ext_id', transform: { op: 'PRESERVE_SOURCE_ID' } },
            { sourcePath: 'legacyName', destinationPath: 'old_name', transform: { op: 'RENAME' } },
          ],
        },
      ],
    };

    const result = dslValidator.validateMappingDsl(validDsl);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it('should reject unallowlisted arbitrary code or operations in mapping DSL', () => {
    const maliciousDsl = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          fields: [
            {
              sourcePath: 'name',
              destinationPath: 'name',
              transform: { op: 'EVAL_JAVASCRIPT', script: 'process.exit(1)' },
            },
          ],
        },
      ],
    };

    const result = dslValidator.validateMappingDsl(maliciousDsl);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].reason).toBe('UNSUPPORTED_OPERATION');
  });

  it('should preview transformations deterministically on sample records without destination side-effects', () => {
    const mappingDsl = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'source_id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
            { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
            { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
            { sourcePath: 'address', destinationPath: 'address', transform: { op: 'TO_JSONB' } },
          ],
        },
      ],
    };

    const sampleRecords = [
      {
        _id: 'mongo_id_998877',
        name: '   Acme Innovations Inc   ',
        email: 'SALES@ACME.COM',
        createdAt: '2026-05-10T12:00:00.000Z',
        address: { city: 'Neo-Tokyo', zip: '100-0001' },
      },
    ];

    const preview = previewService.preview(mappingDsl, sampleRecords);
    expect(preview.length).toBe(1);

    const transformed = preview[0].transformedRecord;
    expect(transformed.source_id).toBe('mongo_id_998877');
    expect(transformed.name).toBe('Acme Innovations Inc');
    expect(transformed.email).toBe('sales@acme.com');
    expect(transformed.created_at).toBe('2026-05-10T12:00:00.000Z');
    expect(transformed.address).toEqual({ city: 'Neo-Tokyo', zip: '100-0001' });
  });
});
