import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { appConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { CredentialsService } from '../connection/credentials.service';
import { TransformationEngine, ObjectMapping } from '@migrationguard/core';
import { v4 as uuidv4 } from 'uuid';

/** Only allow safe SQL identifiers (supports dot-separated identifiers e.g. schema.table) */
function assertSafeIdentifier(name: string, context: string): void {
  if (!name) {
    throw new BadRequestException(`Unsafe SQL identifier rejected in ${context}: empty string.`);
  }
  const parts = name.split('.');
  for (const part of parts) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
      throw new BadRequestException(
        `Unsafe SQL identifier rejected in ${context}: "${name}". Only [a-zA-Z_][a-zA-Z0-9_]* allowed.`,
      );
    }
  }
}

@Injectable()
export class DryRunService {
  private dryRuns = new Map<string, any>();

  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    @Optional() private credentialsService?: CredentialsService,
  ) {}

  async startDryRun(planVersionId: string, userId?: string): Promise<any> {
    const res = await this.db.query('SELECT * FROM migration_plan_versions WHERE id = $1', [
      planVersionId,
    ]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }
    const version = res.rows[0];

    // Retrieve plan to get workspace and project IDs for audit persistence
    const planRes = await this.db.query('SELECT * FROM migration_plans WHERE id = $1', [version.plan_id]);
    const plan = planRes.rows[0] || {};

    const dryRunId = `dry_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Retrieve mapping version and execute real TransformationEngine across ALL mapped objects (Requirement 6)
    let mappings: ObjectMapping[] = [];
    if (version.mapping_version_id) {
      const mapRes = await this.db.query('SELECT * FROM mapping_versions WHERE id = $1', [
        version.mapping_version_id,
      ]);
      if (mapRes.rows.length > 0) {
        const rawJson = mapRes.rows[0].mapping_json;
        const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        mappings = Array.isArray(parsed.objects) ? parsed.objects : (parsed.source ? [parsed] : []);
      }
    }

    if (mappings.length === 0) {
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
        throw new BadRequestException('Cannot perform dry run: no approved object mappings found in plan version.');
      }
      mappings = [{
        source: { object: 'customers', key: 'id' },
        destination: { object: 'customers', key: 'id' },
        identity: { sourceKey: 'id', destinationKey: 'id' },
        fields: [{ sourcePath: 'name', destinationPath: 'name' }],
      } as any];
    }

    // Load destination schema snapshot if configured (or latest snapshot for destination connection)
    let destJson: any = null;
    if (version.destination_schema_snapshot_id) {
      const destSnapRes = await this.db.query('SELECT * FROM schema_snapshots WHERE id = $1', [
        version.destination_schema_snapshot_id,
      ]);
      if (destSnapRes.rows.length > 0) {
        const dSnap = destSnapRes.rows[0];
        // Validate destination schema snapshot is not stale
        if (version.destination_connection_id) {
          const newerRes = await this.db.query(
            `SELECT id, schema_version FROM schema_snapshots
             WHERE connection_id = $1 AND (schema_version > $2 OR created_at > $3)
             LIMIT 1`,
            [version.destination_connection_id, dSnap.schema_version, dSnap.created_at],
          );
          if (newerRes.rows.length > 0 && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
            throw new BadRequestException(
              `Cannot perform dry run: destination schema snapshot ${version.destination_schema_snapshot_id} is stale. An updated destination schema snapshot is required in production.`,
            );
          }
        }
        destJson = dSnap.snapshot_json || {};
      }
    } else if (version.destination_connection_id) {
      const destSnapRes = await this.db.query(
        'SELECT * FROM schema_snapshots WHERE connection_id = $1 ORDER BY schema_version DESC LIMIT 1',
        [version.destination_connection_id],
      );
      if (destSnapRes.rows.length > 0) {
        destJson = destSnapRes.rows[0].snapshot_json || {};
      }
    }

    // In production, destination schema is strictly required for dry-run validation
    if (process.env.NODE_ENV === 'production' && !destJson) {
      throw new BadRequestException(
        'Cannot perform dry run: destination schema snapshot is required in production to validate target constraints.',
      );
    }

    let totalSampleRecordsTested = 0;
    let totalRecordsTransformed = 0;
    let totalTransformationErrors = 0;
    const allPotentialTypeConflicts: string[] = [];
    const objectsTested: Array<{
      sourceObject: string;
      destinationObject: string;
      sampleCount: number;
      transformedCount: number;
      errors: number;
      conflicts: string[];
    }> = [];

    const startTime = Date.now();

    // Iterate through EVERY mapped object (Requirement 6: Multi-object dry run)
    for (const mapping of mappings) {
      const rawSourceObj = (mapping as any)?.source?.object || (mapping as any)?.source?.collection || (typeof (mapping as any)?.source === 'string' ? (mapping as any).source : null);
      const rawDestObj = (mapping as any)?.destination?.object || (mapping as any)?.destination?.table || (typeof (mapping as any)?.destination === 'string' ? (mapping as any).destination : null);

      if (!rawSourceObj || !rawDestObj) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
          throw new BadRequestException('Cannot perform dry run: mapping object missing explicit source or destination specification. Implicit default customers fallback is forbidden in production.');
        }
      }
      const sourceObj = rawSourceObj || 'customers';
      const destObj = rawDestObj || 'customers';

      assertSafeIdentifier(sourceObj, 'dryRun source');
      assertSafeIdentifier(destObj, 'dryRun destination');

      let sampleRecords: any[] = [];
      let liveSamplingAttempted = false;
      let liveSamplingError: Error | null = null;

      // 1. Live source connection sampling using decrypted credentials (P1: Real Source Sampling)
      if (version.source_connection_id && this.credentialsService) {
        liveSamplingAttempted = true;
        try {
          const srcConnRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [version.source_connection_id]);
          if (srcConnRes.rows.length > 0) {
            const srcConn = srcConnRes.rows[0];
            const creds = await this.credentialsService.getDecryptedCredentials(
              srcConn.id,
              srcConn.credential_version,
            );
            if (srcConn.engine === 'MONGODB') {
              const uri = creds?.uri || creds?.connectionString;
              if (uri) {
                const { MongoClient } = require('mongodb');
                const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
                try {
                  await client.connect();
                  const dbName = srcConn.config_json?.database;
                  const coll = client.db(dbName).collection(sourceObj);
                  const docs = await coll.find().limit(500).toArray();
                  if (docs && docs.length > 0) {
                    sampleRecords = docs;
                  }
                } finally {
                  await client.close().catch(() => {});
                }
              }
            } else if (srcConn.engine === 'POSTGRESQL') {
              const connStr = creds?.connectionString || creds?.uri;
              if (connStr && connStr !== appConfig.databaseUrl) {
                const pg = require('pg');
                const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
                try {
                  const sRes = await pool.query(`SELECT * FROM "${sourceObj}" LIMIT 500`);
                  if (sRes.rows.length > 0) {
                    sampleRecords = sRes.rows;
                  }
                } finally {
                  await pool.end().catch(() => {});
                }
              } else {
                try {
                  const sRes = await this.db.query(`SELECT * FROM "${sourceObj}" LIMIT 500`);
                  if (sRes.rows.length > 0) {
                    sampleRecords = sRes.rows;
                  }
                } catch {}
              }
            }
          }
        } catch (err: any) {
          liveSamplingError = err;
          console.warn(`[DryRunService] Live source sampling notice for '${sourceObj}': ${err.message}`);
          if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
            throw new BadRequestException(
              `Live source sampling failed for '${sourceObj}': ${err.message}. Dry run failed closed in production.`,
            );
          }
        }
      }

      // 2. Check schema snapshot samples if live sampling returned empty
      // In production, NEVER substitute stale snapshot samples or fallback when live sampling failed
      if (sampleRecords.length === 0 && version.source_schema_snapshot_id) {
        if (liveSamplingAttempted && liveSamplingError && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
          throw new BadRequestException(
            `Cannot perform dry run: live source sampling failed for '${sourceObj}'. Refusing to substitute snapshot samples in production.`,
          );
        }

        const snapRes = await this.db.query('SELECT * FROM schema_snapshots WHERE id = $1', [
          version.source_schema_snapshot_id,
        ]);
        if (snapRes.rows.length > 0) {
          const sSnap = snapRes.rows[0];

          // Check if snapshot is stale
          let isStale = false;
          if (version.source_connection_id) {
            const newerRes = await this.db.query(
              `SELECT id, schema_version FROM schema_snapshots
               WHERE connection_id = $1 AND (schema_version > $2 OR created_at > $3)
               LIMIT 1`,
              [version.source_connection_id, sSnap.schema_version, sSnap.created_at],
            );
            if (newerRes.rows.length > 0) {
              isStale = true;
            }
            const srcConnCheck = await this.db.query('SELECT credential_version FROM connections WHERE id = $1', [version.source_connection_id]);
            if (srcConnCheck.rows.length > 0 && sSnap.connection_version < (srcConnCheck.rows[0].credential_version || 1)) {
              isStale = true;
            }
          }

          if (isStale) {
            if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
              throw new BadRequestException(
                `Cannot perform dry run: source schema snapshot ${version.source_schema_snapshot_id} is stale. Refusing to substitute stale snapshot samples in production.`,
              );
            }
          } else {
            const sJson = sSnap.snapshot_json || {};
            if (Array.isArray(sJson.samples?.[sourceObj])) {
              sampleRecords = sJson.samples[sourceObj].slice(0, 500);
            } else if (Array.isArray(sJson.collections)) {
              const coll = sJson.collections.find((c: any) => c.name === sourceObj);
              if (coll && Array.isArray(coll.sampleDocuments)) {
                sampleRecords = coll.sampleDocuments.slice(0, 500);
              }
            }
          }
        }
      }

      // 3. Query source table from local database in non-production only
      if (sampleRecords.length === 0 && process.env.NODE_ENV !== 'production' && process.env.ALLOW_SYNTHETIC_SOURCE !== 'false') {
        try {
          const sRes = await this.db.query(`SELECT * FROM "source_${sourceObj}" LIMIT 500`);
          if (sRes.rows.length > 0) {
            sampleRecords = sRes.rows;
          }
        } catch {
          try {
            const sRes = await this.db.query(`SELECT * FROM "${sourceObj}" LIMIT 500`);
            if (sRes.rows.length > 0) {
              sampleRecords = sRes.rows;
            }
          } catch {}
        }
      }

      // 4. Fail-closed in production mode (zero synthetic fallbacks in production)
      if (sampleRecords.length === 0) {
        if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
          throw new BadRequestException(
            `Cannot perform dry run: real source sample records are unavailable from the configured connection for '${sourceObj}'.`,
          );
        }
        // Explicit non-production fallback only when ALLOW_SYNTHETIC_SOURCE=true
        const sampleSize = 500;
        for (let i = 1; i <= sampleSize; i++) {
          sampleRecords.push({
            _id: `${sourceObj}_sample_${i}`,
            name: `Sample ${sourceObj} ${i}`,
            email: `sample_${i}@example.com`,
            createdAt: new Date().toISOString(),
            tier: i % 2 === 0 ? 'ENTERPRISE' : 'STANDARD',
          });
        }
      }

      let objTransformed = 0;
      let objErrors = 0;
      const objConflicts: string[] = [];
      const transformedRecords: any[] = [];

      const engine = new TransformationEngine(mapping);
      for (const rec of sampleRecords) {
        try {
          const transformed = engine.transform(rec);
          if (transformed.warnings && transformed.warnings.length > 0) {
            objConflicts.push(...transformed.warnings);
          }
          transformedRecords.push(transformed.payload || (transformed as any).data || transformed);
          objTransformed++;
        } catch (err: any) {
          objErrors++;
          objConflicts.push(err.message);
        }
      }

      // Validate transformed output against destination schema snapshot
      if (destJson) {
        const destEntities = destJson.tables || destJson.collections || destJson.objects || [];
        const destTable = destEntities.find((t: any) => t.name === destObj);
        if (destTable) {
          const rawCols = destTable.columns || destTable.fields || [];
          const cols = rawCols.map((c: any) => ({
            name: c.name || c.path,
            type: (c.type || c.dataType || c.data_type || c.udt_name || '').toLowerCase(),
            nullable: c.nullable !== false && c.is_nullable !== 'NO',
            isPrimaryKey: !!(c.isPrimaryKey || c.name === 'id' || c.path === 'id' || c.is_primary_key),
            isUnique: !!(c.isUnique || c.unique || c.is_unique),
            maxLength: c.maxLength || c.character_maximum_length,
          }));

          // 1. Identity Key Validation
          const rawDestKey = mapping.identity?.destinationKey || (mapping.destination as any)?.key;
          const destKey = rawDestKey || 'id';
          if (!rawDestKey && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
            objConflicts.push(
              `Mapping for '${destObj}' lacks explicit identity.destinationKey configuration. Implicit default 'id' is prohibited in production.`,
            );
          }
          const keyExists = cols.some((c: any) => c.name === destKey);
          if (!keyExists) {
            objConflicts.push(
              `Configured destination identity key '${destKey}' does not exist in destination table '${destObj}'.`,
            );
          }

          // 2. Nullability Validation (including non-nullable columns and primary keys)
          for (const col of cols) {
            if (!col.nullable || col.isPrimaryKey) {
              const missingInTransformed = transformedRecords.some(
                (tr) => tr[col.name] === undefined || tr[col.name] === null,
              );
              if (missingInTransformed) {
                objConflicts.push(
                  `Destination table '${destObj}' column '${col.name}' is non-nullable but missing in transformed records`,
                );
              }
            }
          }

          // 3. Data Types Validation
          for (const col of cols) {
            if (!col.type) continue;
            for (const tr of transformedRecords) {
              const val = tr[col.name];
              if (val === undefined || val === null) continue;

              if (/int|integer|smallint|bigint/.test(col.type)) {
                const num = Number(val);
                if (!Number.isInteger(num)) {
                  objConflicts.push(
                    `Destination table '${destObj}' column '${col.name}' type mismatch: expected integer, received '${val}'`,
                  );
                  break;
                }
              } else if (/numeric|decimal|float|real|double/.test(col.type)) {
                const num = Number(val);
                if (isNaN(num)) {
                  objConflicts.push(
                    `Destination table '${destObj}' column '${col.name}' type mismatch: expected numeric, received '${val}'`,
                  );
                  break;
                }
              } else if (/bool|boolean/.test(col.type)) {
                if (typeof val !== 'boolean' && val !== 0 && val !== 1 && val !== 'true' && val !== 'false') {
                  objConflicts.push(
                    `Destination table '${destObj}' column '${col.name}' type mismatch: expected boolean, received '${val}'`,
                  );
                  break;
                }
              } else if (/uuid/.test(col.type)) {
                if (typeof val !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
                  objConflicts.push(
                    `Destination table '${destObj}' column '${col.name}' type mismatch: expected valid UUID, received '${val}'`,
                  );
                  break;
                }
              } else if (/date|timestamp|timestamptz/.test(col.type)) {
                const parsed = new Date(val);
                if (isNaN(parsed.getTime())) {
                  objConflicts.push(
                    `Destination table '${destObj}' column '${col.name}' type mismatch: expected valid timestamp/date, received '${val}'`,
                  );
                  break;
                }
              }
              if (col.maxLength && typeof val === 'string' && val.length > col.maxLength) {
                objConflicts.push(
                  `Destination table '${destObj}' column '${col.name}' length exceeded: maximum ${col.maxLength}, received ${val.length}`,
                );
                break;
              }
            }
          }

          // 4. Unique Constraints Validation
          const seenIdentityKeys = new Set<string>();
          let hasDuplicateIdentity = false;
          for (const tr of transformedRecords) {
            const keyVal = tr[destKey];
            if (keyVal !== undefined && keyVal !== null) {
              const sKey = String(keyVal);
              if (seenIdentityKeys.has(sKey)) {
                hasDuplicateIdentity = true;
                break;
              }
              seenIdentityKeys.add(sKey);
            }
          }
          if (hasDuplicateIdentity) {
            objConflicts.push(
              `Destination table '${destObj}' unique constraint violation: duplicate identity key '${destKey}' found in sample records.`,
            );
          }

          // Unique column groups from schema
          const uniqueColGroups: string[][] = [];
          for (const c of cols) {
            if (c.isUnique) uniqueColGroups.push([c.name]);
          }
          if (Array.isArray(destTable.uniqueConstraints)) {
            for (const uc of destTable.uniqueConstraints) {
              const uCols = Array.isArray(uc) ? uc : (uc.columns || [uc.name || uc]);
              uniqueColGroups.push(uCols);
            }
          }
          if (Array.isArray(destTable.indexes)) {
            for (const idx of destTable.indexes) {
              if (idx.isUnique || idx.unique) {
                const idxCols = Array.isArray(idx.columns) ? idx.columns : [idx.column || idx.name];
                uniqueColGroups.push(idxCols);
              }
            }
          }
          for (const uCols of uniqueColGroups) {
            const seenVals = new Set<string>();
            for (const tr of transformedRecords) {
              const hasAll = uCols.every(cn => tr[cn] !== undefined && tr[cn] !== null);
              if (hasAll) {
                const composite = uCols.map(cn => String(tr[cn])).join('::');
                if (seenVals.has(composite)) {
                  objConflicts.push(
                    `Destination table '${destObj}' unique constraint violation on columns [${uCols.join(', ')}] in sample records.`,
                  );
                  break;
                }
                seenVals.add(composite);
              }
            }
          }
        } else {
          objConflicts.push(
            `Destination table '${destObj}' was not found in destination schema snapshot.`,
          );
        }
      }

      totalSampleRecordsTested += sampleRecords.length;
      totalRecordsTransformed += objTransformed;
      totalTransformationErrors += objErrors;
      allPotentialTypeConflicts.push(...objConflicts);

      objectsTested.push({
        sourceObject: sourceObj,
        destinationObject: destObj,
        sampleCount: sampleRecords.length,
        transformedCount: objTransformed,
        errors: objErrors,
        conflicts: objConflicts,
      });
    }

    const measuredDurationMs = Math.max(1, Date.now() - startTime);
    const measuredRatePerSec = Math.round((totalRecordsTransformed / (measuredDurationMs || 1)) * 1000);
    // Treat transformation errors and destination schema conflicts as strict approval blockers
    const readyForApproval = totalTransformationErrors === 0 && allPotentialTypeConflicts.length === 0 && totalRecordsTransformed > 0;

    const dryRunResult = {
      id: dryRunId,
      planVersionId,
      workspaceId: plan.workspace_id,
      planHash: version.plan_hash,
      status: readyForApproval ? 'COMPLETED' : 'FAILED',
      // Measured facts
      measuredFacts: {
        sampleRecordsTested: totalSampleRecordsTested,
        recordsTransformed: totalRecordsTransformed,
        transformationErrors: totalTransformationErrors,
        measuredDurationMs,
        measuredRatePerSec,
      },
      // Estimated projections
      projectedEstimates: {
        projectedBatchDurationMs: Math.round((1000 / (measuredRatePerSec || 1)) * 1000),
        projectedThroughputPerSec: measuredRatePerSec,
      },
      sampleRecordsTested: totalSampleRecordsTested,
      recordsTransformed: totalRecordsTransformed,
      transformationErrors: totalTransformationErrors,
      potentialTypeConflicts: allPotentialTypeConflicts,
      objectsTested,
      readyForApproval,
      executedAt: new Date().toISOString(),
    };

    // Durably persist dry run execution into audit events
    if (plan.workspace_id) {
      let actorId = userId || version.created_by || plan.created_by;
      if (!actorId) {
        const userRes = await this.db.query('SELECT id FROM users WHERE workspace_id = $1 LIMIT 1', [plan.workspace_id]);
        if (userRes.rows.length > 0) {
          actorId = userRes.rows[0].id;
        } else {
          const anyUser = await this.db.query('SELECT id FROM users LIMIT 1');
          if (anyUser.rows.length > 0) {
            actorId = anyUser.rows[0].id;
          }
        }
      }

      if (actorId) {
        try {
          await this.db.query(
            `INSERT INTO audit_events (
               workspace_id, project_id, actor_type, actor_id, action,
               resource_type, resource_id, details_json
             )
             VALUES ($1, $2, $3, $4, 'DRY_RUN_COMPLETED', 'PLAN_VERSION', $5, $6)`,
            [
              plan.workspace_id,
              plan.project_id || null,
              userId ? 'USER' : 'SYSTEM',
              actorId,
              planVersionId,
              dryRunResult,
            ],
          );
        } catch (err: any) {
          console.warn(`[DryRunService] Audit event logging fallback: ${err.message}`);
        }
      }
    }

    this.dryRuns.set(dryRunId, dryRunResult);
    return dryRunResult;
  }

  async getDryRun(dryRunId: string, userId?: string): Promise<any> {
    let dryRun = this.dryRuns.get(dryRunId);

    if (!dryRun) {
      // Attempt lookup from durable audit log
      const auditRes = await this.db.query(
        `SELECT details_json, workspace_id FROM audit_events WHERE action = 'DRY_RUN_COMPLETED' AND details_json->>'id' = $1`,
        [dryRunId],
      );
      if (auditRes.rows.length > 0) {
        dryRun = auditRes.rows[0].details_json;
        dryRun.workspaceId = dryRun.workspaceId || auditRes.rows[0].workspace_id;
        this.dryRuns.set(dryRunId, dryRun);
      }
    }

    if (!dryRun) {
      throw new NotFoundException(`Dry run ${dryRunId} not found.`);
    }

    // Enforce workspace authorization (IDOR Protection)
    if (userId) {
      let wsId = dryRun.workspaceId;
      if (!wsId && dryRun.planVersionId) {
        const vRes = await this.db.query(
          `SELECT mp.workspace_id FROM migration_plan_versions mpv
           JOIN migration_plans mp ON mpv.plan_id = mp.id
           WHERE mpv.id = $1`,
          [dryRun.planVersionId],
        );
        if (vRes.rows.length > 0) {
          wsId = vRes.rows[0].workspace_id;
        }
      }
      if (wsId) {
        await this.workspaceService.assertWorkspaceAccess(wsId, userId, 'Viewer');
      }
    }

    return dryRun;
  }
}
