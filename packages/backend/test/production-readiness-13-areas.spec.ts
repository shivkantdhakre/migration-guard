import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReadinessService } from '../src/plan/readiness.service';
import { DryRunService } from '../src/plan/dry-run.service';
import { BadRequestException } from '@nestjs/common';

describe('Production Readiness Regression - Backend Areas (1, 2, 12, 13)', () => {
  let mockDb: any;
  let mockWorkspaceService: any;
  let mockConnectionService: any;
  let mockCredentialsService: any;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };
    mockWorkspaceService = {
      ensureWorkspaceAccess: vi.fn().mockResolvedValue(undefined),
    };
    mockConnectionService = {
      getConnection: vi.fn(),
    };
    mockCredentialsService = {
      getDecryptedCredentials: vi.fn(),
    };
  });

  describe('Area 13: Readiness & Identity Validation', () => {
    it('preserves isUnique metadata and reports blocker when identity column is not backed by PK or unique constraint', async () => {
      const readinessService = new ReadinessService(
        mockDb,
        mockWorkspaceService,
        mockConnectionService,
        mockCredentialsService,
      );

      const planVersion = {
        id: 'pv_123',
        migration_plan_id: 'plan_123',
        mapping_version_id: 'mv_123',
        source_connection_id: 'src_conn_1',
        destination_connection_id: 'dst_conn_1',
        source_schema_snapshot_id: 'snap_src_1',
        destination_schema_snapshot_id: 'snap_dst_1',
        execution_config_json: { batchSize: 1000 },
      };

      const mappingVersion = {
        id: 'mv_123',
        version: 1,
        mapping_hash: 'abc1234567890123456789',
        mapping_json: {
          objects: [
            {
              source: { collection: 'users' },
              destination: { table: 'users_target' },
              identity: { sourceKey: '_id', destinationKey: 'user_code' },
              fields: [
                { destinationPath: 'user_code' },
                { destinationPath: 'full_name' },
              ],
            },
          ],
        },
      };

      const dstSnapshot = {
        id: 'snap_dst_1',
        schema_version: 1,
        created_at: new Date('2026-01-01'),
        snapshot_json: {
          tables: [
            {
              name: 'users_target',
              columns: [
                { name: 'user_code', type: 'varchar', nullable: false, isPrimaryKey: false, isUnique: false },
                { name: 'full_name', type: 'varchar', nullable: true, isPrimaryKey: false, isUnique: false },
              ],
              constraints: [],
            },
          ],
        },
      };

      const srcSnapshot = {
        id: 'snap_src_1',
        schema_version: 1,
        created_at: new Date('2026-01-01'),
        snapshot_json: {
          collections: [{ name: 'users', fields: [{ path: '_id' }, { path: 'name' }] }],
        },
      };

      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('FROM migration_plan_versions')) {
          return { rows: [planVersion] };
        }
        if (sql.includes('FROM mapping_versions')) {
          return { rows: [mappingVersion] };
        }
        if (sql.includes('FROM schema_snapshots WHERE id = $1')) {
          if (params[0] === 'snap_dst_1') return { rows: [dstSnapshot] };
          if (params[0] === 'snap_src_1') return { rows: [srcSnapshot] };
        }
        if (sql.includes('FROM connections WHERE id = $1')) {
          return { rows: [{ id: params[0], engine: 'POSTGRESQL', credential_version: 1 }] };
        }
        if (sql.includes('SELECT id, schema_version FROM schema_snapshots')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const report = await readinessService.checkReadiness('pv_123');

      expect(report.ready).toBe(false);
      expect(report.blockers).toContain(
        "Identity column 'user_code' for destination table 'users_target' is not backed by a primary key or unique constraint.",
      );
    });

    it('validates composite identity keys against matching composite primary key or unique constraints', async () => {
      const readinessService = new ReadinessService(
        mockDb,
        mockWorkspaceService,
        mockConnectionService,
        mockCredentialsService,
      );

      const planVersion = {
        id: 'pv_composite',
        migration_plan_id: 'plan_comp',
        mapping_version_id: 'mv_composite',
        source_connection_id: 'src_conn_1',
        destination_connection_id: 'dst_conn_1',
        source_schema_snapshot_id: 'snap_src_1',
        destination_schema_snapshot_id: 'snap_dst_1',
        execution_config_json: { batchSize: 1000 },
      };

      const mappingVersion = {
        id: 'mv_composite',
        version: 1,
        mapping_hash: 'abc1234567890123456789',
        mapping_json: {
          objects: [
            {
              source: { collection: 'tenants' },
              destination: { table: 'tenants_target' },
              identity: { sourceKey: 'id', destinationKey: 'tenant_id, org_id' },
              fields: [
                { destinationPath: 'tenant_id' },
                { destinationPath: 'org_id' },
              ],
            },
          ],
        },
      };

      const dstSnapshot = {
        id: 'snap_dst_1',
        schema_version: 1,
        created_at: new Date('2026-01-01'),
        snapshot_json: {
          tables: [
            {
              name: 'tenants_target',
              columns: [
                { name: 'tenant_id', type: 'varchar', nullable: false, isPrimaryKey: false, isUnique: false },
                { name: 'org_id', type: 'varchar', nullable: false, isPrimaryKey: false, isUnique: false },
              ],
              constraints: [
                { name: 'uq_tenant_user', type: 'UNIQUE', columns: ['tenant_id', 'user_id'] },
              ],
            },
          ],
        },
      };

      const srcSnapshot = {
        id: 'snap_src_1',
        schema_version: 1,
        created_at: new Date('2026-01-01'),
        snapshot_json: {
          collections: [{ name: 'tenants', fields: [{ path: 'id' }] }],
        },
      };

      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
        if (sql.includes('FROM mapping_versions')) return { rows: [mappingVersion] };
        if (sql.includes('FROM schema_snapshots WHERE id = $1')) {
          if (params[0] === 'snap_dst_1') return { rows: [dstSnapshot] };
          if (params[0] === 'snap_src_1') return { rows: [srcSnapshot] };
        }
        if (sql.includes('FROM connections WHERE id = $1')) {
          return { rows: [{ id: params[0], engine: 'POSTGRESQL', credential_version: 1 }] };
        }
        if (sql.includes('SELECT id, schema_version FROM schema_snapshots')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const report = await readinessService.checkReadiness('pv_composite');

      expect(report.ready).toBe(false);
      expect(report.blockers.some((b) => b.includes('not backed by a matching composite primary key or unique constraint'))).toBe(true);
    });
  });

  describe('Area 12: Dry-run Schema Inspection', () => {
    it('throws BadRequestException in production when live destination catalog inspection fails', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const dryRunService = new DryRunService(
          mockDb,
          mockConnectionService,
          mockCredentialsService,
        );

        const planVersion = {
          id: 'pv_dry_fail',
          migration_plan_id: 'plan_1',
          mapping_version_id: 'mv_1',
          source_connection_id: 'src_1',
          destination_connection_id: 'dst_1',
          source_schema_snapshot_id: 'snap_src_1',
          destination_schema_snapshot_id: 'snap_dst_1',
          scope_json: { tables: ['users'] },
        };

        const mappingVersion = {
          id: 'mv_1',
          version: 1,
          mapping_hash: 'abc1234567890123456789',
          mapping_json: {
            objects: [
              {
                source: { collection: 'users' },
                destination: { table: 'users_target' },
                identity: { sourceKey: 'id', destinationKey: 'id' },
                fields: [{ destinationPath: 'id' }],
              },
            ],
          },
        };

        mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
          if (sql.includes('FROM mapping_versions')) return { rows: [mappingVersion] };
          if (sql.includes('FROM schema_snapshots WHERE id = $1')) {
            return { rows: [{ id: params[0], snapshot_json: { tables: [] }, schema_version: 1, created_at: new Date() }] };
          }
          if (sql.includes('SELECT id, schema_version FROM schema_snapshots')) {
            return { rows: [{ id: 'snap_newer', schema_version: 2 }] };
          }
          if (sql.includes('FROM connections WHERE id = $1')) {
            return { rows: [{ id: 'dst_1', engine: 'POSTGRESQL', credential_version: 1 }] };
          }
          return { rows: [] };
        });

        // Mock credentials service to fail / return invalid connection
        mockCredentialsService.getDecryptedCredentials.mockRejectedValue(
          new Error('Vault connectivity timeout'),
        );

        await expect(dryRunService.startDryRun('pv_dry_fail')).rejects.toThrow(BadRequestException);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });
});
