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
      assertWorkspaceAccess: vi.fn().mockResolvedValue(undefined),
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

    it('refuses single-column identity key when column only participates in a composite unique constraint', async () => {
      const readinessService = new ReadinessService(
        mockDb,
        mockWorkspaceService,
        mockConnectionService,
        mockCredentialsService,
      );

      const planVersion = {
        id: 'pv_composite_single',
        migration_plan_id: 'plan_comp_single',
        mapping_version_id: 'mv_composite_single',
        source_connection_id: 'src_conn_1',
        destination_connection_id: 'dst_conn_1',
        source_schema_snapshot_id: 'snap_src_1',
        destination_schema_snapshot_id: 'snap_dst_1',
        execution_config_json: { batchSize: 1000 },
      };

      // Configuration maps single identity key 'tenant_id'
      const mappingVersion = {
        id: 'mv_composite_single',
        version: 1,
        mapping_hash: 'abc1234567890123456789',
        mapping_json: {
          objects: [
            {
              source: { collection: 'tenants' },
              destination: { table: 'tenants_target' },
              identity: { sourceKey: 'id', destinationKey: 'tenant_id' }, // Configured as single identity!
              fields: [
                { destinationPath: 'tenant_id' },
                { destinationPath: 'org_id' },
              ],
            },
          ],
        },
      };

      // Destination table has composite constraint UNIQUE(tenant_id, org_id) - NOT single column unique!
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
                { name: 'uq_tenant_org', type: 'UNIQUE', columns: ['tenant_id', 'org_id'] },
              ],
            },
          ],
        },
      };

      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
        if (sql.includes('FROM mapping_versions')) return { rows: [mappingVersion] };
        if (sql.includes('FROM schema_snapshots WHERE id = $1')) {
          if (params[0] === 'snap_dst_1') return { rows: [dstSnapshot] };
          if (params[0] === 'snap_src_1') return { rows: [{ id: 'snap_src_1', snapshot_json: { collections: [] } }] };
        }
        if (sql.includes('FROM connections WHERE id = $1')) {
          return { rows: [{ id: params[0], engine: 'POSTGRESQL', credential_version: 1 }] };
        }
        if (sql.includes('SELECT id, schema_version FROM schema_snapshots')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const report = await readinessService.checkReadiness('pv_composite_single');

      expect(report.ready).toBe(false);
      expect(report.blockers).toContain(
        "Identity column 'tenant_id' for destination table 'tenants_target' is not backed by a primary key or unique constraint.",
      );
    });

    it('in production, reports blocker when live destination schema catalog inspection fails and refuses snapshot fallback', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const readinessService = new ReadinessService(
          mockDb,
          mockWorkspaceService,
          mockConnectionService,
          mockCredentialsService,
        );

        const planVersion = {
          id: 'pv_prod_live_fail',
          migration_plan_id: 'plan_1',
          mapping_version_id: 'mv_1',
          source_connection_id: 'src_1',
          destination_connection_id: 'dst_1',
          source_schema_snapshot_id: 'snap_src_1',
          destination_schema_snapshot_id: 'snap_dst_1',
          execution_config_json: { batchSize: 1000 },
        };

        mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
          if (sql.includes('FROM mapping_versions')) {
            return {
              rows: [
                {
                  id: 'mv_1',
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
                },
              ],
            };
          }
          if (sql.includes('FROM schema_snapshots WHERE id = $1')) {
            return { rows: [{ id: params[0], snapshot_json: { tables: [] }, schema_version: 1, created_at: new Date() }] };
          }
          if (sql.includes('FROM connections WHERE id = $1')) {
            return { rows: [{ id: 'dst_1', engine: 'POSTGRESQL', credential_version: 1 }] };
          }
          return { rows: [] };
        });

        mockCredentialsService.getDecryptedCredentials.mockRejectedValue(
          new Error('Live connection refused'),
        );

        const report = await readinessService.checkReadiness('pv_prod_live_fail');
        expect(report.ready).toBe(false);
        expect(report.blockers.some((b) => b.includes('Live destination schema catalog inspection failed') || b.includes('mandatory when destination connection is configured'))).toBe(true);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
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

  describe('Area 1 & 2: Mapping Resolution, Connection Overrides & Streaming Metadata', () => {
    it('persists complete metadata and per-object connection overrides in initial and streaming batches', async () => {
      const { MigrationService } = await import('../src/migration/migration.service');
      const mockQueueService: any = {
        dispatchBatches: vi.fn().mockResolvedValue(undefined),
      };

      const migrationService = new MigrationService(
        mockDb,
        mockWorkspaceService,
        mockQueueService,
      );

      // Verify streaming batch persistence with complete metadata
      const insertedBatches: any[] = [];
      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT * FROM migration_runs WHERE id = $1')) {
          return { rows: [{ id: 'run_stream_1', status: 'RUNNING', plan_version_id: 'plan_ver_1' }] };
        }
        if (sql.includes('SELECT * FROM migration_plan_versions WHERE id = $1')) {
          return {
            rows: [
              {
                id: 'plan_ver_1',
                source_connection_id: 'src_default_conn',
                destination_connection_id: 'dst_default_conn',
                mapping_version_id: 'map_ver_1',
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO migration_batches')) {
          insertedBatches.push({ sql, params });
          return { rows: [] };
        }
        if (sql.includes('SELECT * FROM migration_batches WHERE status = $1')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const res = await migrationService.scheduleStreamingBatch({
        migrationRunId: 'run_stream_1',
        batchKey: 'batch_orders_002',
        sequenceNo: 2,
        sourceObject: 'orders',
        destinationObject: 'orders_target',
        destinationKey: 'order_id',
        sourceConnectionId: 'src_override_conn',
        destinationConnectionId: 'dst_override_conn',
        mappingVersionId: 'map_ver_1',
        planVersionId: 'plan_ver_1',
        cursorStart: { offset: 100 },
        cursorEnd: { offset: 200 },
      });

      expect(res.status).toBe('PENDING');
      expect(insertedBatches).toHaveLength(1);

      const insertCall = insertedBatches[0];
      expect(insertCall.sql).toContain('source_connection_id');
      expect(insertCall.sql).toContain('destination_connection_id');
      expect(insertCall.sql).toContain('destination_key');
      expect(insertCall.sql).toContain('plan_version_id');
      expect(insertCall.sql).toContain('metadata');

      // Verify params passed
      expect(insertCall.params[6]).toBe('src_override_conn');
      expect(insertCall.params[7]).toBe('dst_override_conn');
      expect(insertCall.params[8]).toBe('order_id');
      expect(insertCall.params[9]).toBe('plan_ver_1');
      const meta = JSON.parse(insertCall.params[10]);
      expect(meta.sourceConnectionId).toBe('src_override_conn');
      expect(meta.destinationConnectionId).toBe('dst_override_conn');
      expect(meta.destinationKey).toBe('order_id');
    });

    it('fails closed when mapping is missing or ambiguous across source and destination', async () => {
      const { MigrationService } = await import('../src/migration/migration.service');
      const mockQueueService: any = {
        dispatchBatches: vi.fn(),
      };

      const migrationService = new MigrationService(
        mockDb,
        mockWorkspaceService,
        mockQueueService,
      );

      const planVersion = {
        id: 'pv_ambig',
        workspace_id: 'ws_1',
        project_id: 'proj_1',
        plan_hash: 'hash_ambig',
        status: 'APPROVED',
        mapping_version_id: 'mv_ambig',
        source_connection_id: 'src_1',
        destination_connection_id: 'dst_1',
        scope_json: { tables: [{ source: 'customers', destination: 'clients' }] },
      };

      // Ambiguous: two mappings for the same source and destination
      const ambiguousMapping = {
        id: 'mv_ambig',
        mapping_json: {
          objects: [
            { source: 'customers', destination: 'clients', identity: { destinationKey: 'id' } },
            { source: 'customers', destination: 'clients', identity: { destinationKey: 'client_id' } },
          ],
        },
      };

      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
        if (sql.includes('FROM approvals')) return { rows: [{ approval_status: 'APPROVE', resource_hash: 'hash_ambig' }] };
        if (sql.includes('FROM mapping_versions')) return { rows: [ambiguousMapping] };
        if (sql.includes('INSERT INTO migration_runs')) return { rows: [{ id: 'run_ambig', status: 'QUEUED' }] };
        return { rows: [] };
      });

      await expect(
        migrationService.startMigrationRun('pv_ambig', 'user_1'),
      ).rejects.toThrow(/Ambiguous mapping: multiple mappings match/);
    });
  });

  describe('Finding 5: Dry-Run Strict Identity & Composite Constraint Validation', () => {
    it('rejects identity column named id when not backed by dedicated PK or uniqueness constraint', async () => {
      const dryRunService = new DryRunService(
        mockDb,
        mockWorkspaceService,
        mockConnectionService,
        mockCredentialsService,
      );

      const planVersion = {
        id: 'pv_dryrun_id_check',
        plan_id: 'plan_test',
        migration_plan_id: 'plan_test',
        mapping_version_id: 'mv_dryrun_id_check',
        source_connection_id: null,
        destination_connection_id: null,
        source_schema_snapshot_id: 'snap_src',
        destination_schema_snapshot_id: 'snap_dst',
        execution_config_json: {},
      };

      const plan = {
        id: 'plan_test',
        workspace_id: 'ws_1',
        project_id: 'proj_1',
      };

      const mappingVersion = {
        id: 'mv_dryrun_id_check',
        mapping_json: {
          objects: [
            {
              source: { object: 'users' },
              destination: { object: 'users', key: 'id' },
              identity: { sourceKey: 'id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
              fields: [],
            },
          ],
        },
      };

      // Destination schema snapshot where table 'users' has column 'id' that is NOT primary key and NOT unique
      const destSnapshot = {
        id: 'snap_dst',
        schema_version: 1,
        created_at: new Date(),
        snapshot_json: {
          tables: [
            {
              name: 'users',
              columns: [
                { name: 'id', type: 'text', nullable: false, isPrimaryKey: false, isUnique: false },
                { name: 'name', type: 'text', nullable: true },
              ],
              constraints: [], // No PK or Unique constraint on 'id'!
            },
          ],
        },
      };

      const srcSnapshot = {
        id: 'snap_src',
        schema_version: 1,
        created_at: new Date(),
        snapshot_json: {
          collections: [{ name: 'users', fields: [{ path: 'id', type: 'string' }] }],
        },
      };

      mockDb.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('FROM migration_plan_versions')) return { rows: [planVersion] };
        if (sql.includes('FROM migration_plans')) return { rows: [plan] };
        if (sql.includes('FROM mapping_versions')) return { rows: [mappingVersion] };
        if (sql.includes('FROM schema_snapshots') && params[0] === 'snap_dst') return { rows: [destSnapshot] };
        if (sql.includes('FROM schema_snapshots') && params[0] === 'snap_src') return { rows: [srcSnapshot] };
        if (sql.includes('FROM connections')) return { rows: [] };
        if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'user_1' }] };
        return { rows: [] };
      });

      const result = await dryRunService.startDryRun('pv_dryrun_id_check', 'user_1');
      expect(result.potentialTypeConflicts).toContain(
        "Destination identity key 'id' in table 'users' is not backed by a primary key or unique constraint.",
      );
    });
  });

  describe('Finding 7: MappingPreviewService Exact Matching & Fallback Prohibition', () => {
    it('exact source AND destination matching resolves target object accurately and rejects ambiguous target', async () => {
      const { MappingPreviewService } = await import('../src/mapping/mapping-preview.service');
      const previewService = new MappingPreviewService();

      const multiMapping = {
        objects: [
          {
            source: { object: 'users' },
            destination: { object: 'accounts' },
            identity: { sourceKey: '_id', destinationKey: 'account_id', strategy: 'PRESERVE_AS_TEXT' },
            fields: [{ sourcePath: 'name', destinationPath: 'account_name', transform: { op: 'TRIM_STRING' } }],
          },
          {
            source: { object: 'users' },
            destination: { object: 'user_profiles' },
            identity: { sourceKey: '_id', destinationKey: 'profile_id', strategy: 'PRESERVE_AS_TEXT' },
            fields: [{ sourcePath: 'name', destinationPath: 'display_name', transform: { op: 'UPPERCASE' } }],
          },
        ],
      };

      const samples = [{ _id: '123', name: '  Alice  ' }];

      // Exact match for users -> accounts
      const res1 = previewService.preview(multiMapping, samples, 'users', 'accounts');
      expect(res1).toHaveLength(1);
      expect(res1[0].transformedRecord).toEqual({
        account_id: '123',
        account_name: 'Alice',
      });

      // Exact match for users -> user_profiles
      const res2 = previewService.preview(multiMapping, samples, 'users', 'user_profiles');
      expect(res2).toHaveLength(1);
      expect(res2[0].transformedRecord).toEqual({
        profile_id: '123',
        display_name: '  ALICE  ',
      });

      // Target that does not exist in mapping must return empty (not silently fallback to object[0])
      const resUnmatched = previewService.preview(multiMapping, samples, 'orders', 'invoices');
      expect(resUnmatched).toHaveLength(0);

      // Single target matching multiple sources throws ambiguity error requiring destination disambiguation
      expect(() => previewService.preview(multiMapping, samples, 'users')).toThrow(
        /Ambiguous mapping: multiple approved objects match source 'users'\. Specify destination to disambiguate\./,
      );

      // Single target passed as destination name cannot match as source (no source-OR-destination confusion)
      const resDestAsSource = previewService.preview(multiMapping, samples, 'accounts');
      expect(resDestAsSource).toHaveLength(0);
    });
  });

  describe('Finding 9: Autonomous Outbox Publisher Structured Error Logging & Metrics', () => {
    it('captures dispatch errors in failure metrics and exposes getOutboxPublisherMetrics', async () => {
      const { MigrationService } = await import('../src/migration/migration.service');
      const mockQueue: any = {
        dispatchBatches: vi.fn().mockRejectedValue(new Error('Redis connection timeout')),
      };

      const customDb: any = {
        query: vi.fn().mockRejectedValue(new Error('Simulated control-plane db error')),
      };

      const migrationService = new MigrationService(customDb, mockWorkspaceService, mockQueue);

      migrationService.startAutonomousOutboxPublisher(20);

      // Wait a short time for timer to trigger
      await new Promise((resolve) => setTimeout(resolve, 80));
      migrationService.stopAutonomousOutboxPublisher();

      const metrics = migrationService.getOutboxPublisherMetrics();
      expect(metrics.failureCount).toBeGreaterThan(0);
      expect(metrics.lastError).toContain('Simulated control-plane db error');
      expect(metrics.lastErrorTimestamp).toBeInstanceOf(Date);
    });
  });
});
