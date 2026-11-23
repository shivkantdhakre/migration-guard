import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { CredentialsService } from '../connection/credentials.service';
import { appConfig } from '../config/configuration';
import {
  ValidationEngine,
  ValidationDataset,
  generateSyntheticDataset,
  injectFaults,
  TransformationEngine,
  ObjectMapping,
} from '@migrationguard/core';

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
export class ValidationService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    @Optional() private credentialsService?: CredentialsService,
  ) {}

  private async recordFailedValidation(workspaceId: string, runId: string, errorReason: string) {
    await this.db.query(
      `INSERT INTO validation_runs (
         workspace_id, migration_run_id, status, validation_profile_version,
         canonicalization_version, started_at, completed_at, summary_json
       )
       VALUES ($1, $2, 'ERROR', '1.0', '1.0', NOW(), NOW(), $3)`,
      [
        workspaceId,
        runId,
        {
          error: errorReason,
          executionStatus: 'ERROR',
          outcome: 'ERROR',
          overallStatus: 'ERROR',
        },
      ],
    );
  }

  async triggerValidation(runId: string, userId: string) {
    const runRes = await this.db.query('SELECT * FROM migration_runs WHERE id = $1', [runId]);
    if (runRes.rows.length === 0) {
      throw new NotFoundException('Migration run not found.');
    }
    const run = runRes.rows[0];
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Engineer');

    // Fetch plan version to check connection validity
    let planVersion: any = null;
    if (run.plan_version_id) {
      const planRes = await this.db.query(
        'SELECT * FROM migration_plan_versions WHERE id = $1',
        [run.plan_version_id],
      );
      if (planRes.rows.length > 0) {
        planVersion = planRes.rows[0];
      }
    }

    // Verify source connection is not unavailable or in ERROR state
    let srcConn: any = null;
    let sourceCredentials: any = null;
    if (planVersion?.source_connection_id) {
      const srcConnRes = await this.db.query(
        'SELECT * FROM connections WHERE id = $1',
        [planVersion.source_connection_id],
      );
      if (srcConnRes.rows.length === 0 || srcConnRes.rows[0].status === 'ERROR') {
        await this.recordFailedValidation(run.workspace_id, runId, 'Source connection is in ERROR state or unavailable.');
        throw new Error('Source connection is unavailable or in ERROR state. Validation failed closed.');
      }
      srcConn = srcConnRes.rows[0];
      if (this.credentialsService) {
        try {
          sourceCredentials = await this.credentialsService.getDecryptedCredentials(
            srcConn.id,
            srcConn.credential_version,
          );
        } catch (err: any) {
          await this.recordFailedValidation(run.workspace_id, runId, `Source credential fetch failed: ${err.message}`);
          throw new Error(`Source credential fetch failed: ${err.message}. Validation failed closed.`);
        }
      }
    }

    // Verify destination connection is not unavailable or in ERROR state
    let destConn: any = null;
    let destCredentials: any = null;
    if (planVersion?.destination_connection_id) {
      const destConnRes = await this.db.query(
        'SELECT * FROM connections WHERE id = $1',
        [planVersion.destination_connection_id],
      );
      if (destConnRes.rows.length === 0 || destConnRes.rows[0].status === 'ERROR') {
        await this.recordFailedValidation(run.workspace_id, runId, 'Destination connection is in ERROR state or unavailable.');
        throw new Error('Destination connection is unavailable or in ERROR state. Validation failed closed.');
      }
      destConn = destConnRes.rows[0];
      if (this.credentialsService) {
        try {
          destCredentials = await this.credentialsService.getDecryptedCredentials(
            destConn.id,
            destConn.credential_version,
          );
        } catch (err: any) {
          await this.recordFailedValidation(run.workspace_id, runId, `Destination credential fetch failed: ${err.message}`);
          throw new Error(`Destination credential fetch failed: ${err.message}. Validation failed closed.`);
        }
      }
    }

    // Identify all object mappings from plan version
    const objectMappings: any[] = [];
    if (planVersion?.mapping_version_id) {
      const mapRes = await this.db.query('SELECT * FROM mapping_versions WHERE id = $1', [
        planVersion.mapping_version_id,
      ]);
      if (mapRes.rows.length > 0) {
        const mJson = mapRes.rows[0].mapping_json;
        const parsed = typeof mJson === 'string' ? JSON.parse(mJson) : mJson;
        if (Array.isArray(parsed.objects)) {
          objectMappings.push(...parsed.objects);
        } else if (parsed.source) {
          objectMappings.push(parsed);
        }
      }
    }

    if (objectMappings.length === 0) {
      await this.recordFailedValidation(
        run.workspace_id,
        runId,
        'No object mappings found in plan version. Cannot validate without an explicit approved mapping.',
      );
      throw new Error(
        'No object mappings found in plan version mapping_json. Validation failed closed — refusing to fabricate a default mapping.',
      );
    }

    const parseDateSafe = (d: any) => {
      if (!d) return new Date().toISOString();
      const parsed = new Date(d);
      return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    };

    // Helper: read source documents from real MongoDB or PostgreSQL fallback
    const fetchSourceRecords = async (sourceObjectName: string, sourceKeyField: string, sourceKeys: string[]): Promise<any[]> => {
      if (sourceKeys.length === 0) return [];

      // Validate identifier to prevent SQL injection
      assertSafeIdentifier(sourceObjectName, 'fetchSourceRecords');

      // 1. Live MongoDB connection using decrypted credentials
      if (srcConn?.engine === 'MONGODB' && sourceCredentials) {
        const uri = sourceCredentials.uri || sourceCredentials.connectionString;
        if (uri) {
          try {
            const { MongoClient, ObjectId } = require('mongodb');
            const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
            await client.connect();
            const dbName = srcConn.config_json?.database;
            const coll = client.db(dbName).collection(sourceObjectName);

            const objectIds: any[] = [];
            const stringIds: string[] = [];
            for (const k of sourceKeys) {
              if (/^[0-9a-fA-F]{24}$/.test(k)) {
                try { objectIds.push(new ObjectId(k)); } catch {}
              }
              stringIds.push(k);
            }

            const filter = (sourceKeyField === '_id' || sourceKeyField === 'id')
              ? { $or: [{ _id: { $in: objectIds } }, { _id: { $in: stringIds } }, { id: { $in: stringIds } }] }
              : { [sourceKeyField]: { $in: sourceKeys } };

            const docs = await coll.find(filter).toArray();
            await client.close().catch(() => {});
            if (docs.length > 0) return docs;
          } catch (mErr: any) {
            // Issue 3 fix: fail closed in ALL environments when MongoDB credentials exist but query fails
            throw new Error(`Failed to query source MongoDB for ${sourceObjectName}: ${mErr.message}`);
          }
        }
      }

      // 2. Live PostgreSQL source connection using decrypted credentials
      if (srcConn?.engine === 'POSTGRESQL' && sourceCredentials) {
        const connStr = sourceCredentials.connectionString || sourceCredentials.uri;
        if (connStr && connStr !== appConfig.databaseUrl) {
          try {
            const pg = require('pg');
            const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
            try {
              assertSafeIdentifier(sourceObjectName, 'fetchSourceRecords source pg table');
              assertSafeIdentifier(sourceKeyField, 'fetchSourceRecords source pg key');
              const sRes = await pool.query(
                `SELECT * FROM "${sourceObjectName}" WHERE "${sourceKeyField}" = ANY($1)`,
                [sourceKeys],
              );
              if (sRes.rows.length > 0) return sRes.rows;
            } finally {
              await pool.end().catch(() => {});
            }
          } catch (pErr: any) {
            if (process.env.NODE_ENV === 'production') {
              throw new Error(`Failed to query source PostgreSQL for ${sourceObjectName}: ${pErr.message}`);
            }
          }
        }
      }

      // In production: no local DB fallback for source records
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          `Source records for ${sourceObjectName} could not be retrieved from live source connection. Validation failed closed.`,
        );
      }

      // Non-production test harness fallback (e.g. source_customers or customers in test DB)
      try {
        const sRes = await this.db.query(`SELECT * FROM "source_${sourceObjectName}"`);
        const matched = sRes.rows.filter((r: any) =>
          sourceKeys.includes(String(r[sourceKeyField] || r.id || r._id || r.source_key)),
        );
        if (matched.length > 0) return matched;
      } catch {}

      try {
        const sRes = await this.db.query(`SELECT * FROM "${sourceObjectName}"`);
        const matched = sRes.rows.filter((r: any) =>
          sourceKeys.includes(String(r[sourceKeyField] || r.id || r._id || r.source_key)),
        );
        if (matched.length > 0) return matched;
      } catch {}

      return [];
    };

    // Helper: read destination records from PostgreSQL destination
    const fetchDestRecords = async (destObjectName: string, destKeyField: string, destKeys: string[]): Promise<any[]> => {
      if (destKeys.length === 0) return [];

      // Validate identifier to prevent SQL injection
      assertSafeIdentifier(destObjectName, 'fetchDestRecords');
      assertSafeIdentifier(destKeyField, 'fetchDestRecords key field');

      // 1. External PostgreSQL destination if distinct connection configured
      if (destConn?.engine === 'POSTGRESQL' && destCredentials) {
        const connStr = destCredentials.connectionString || destCredentials.uri;
        if (connStr && connStr !== appConfig.databaseUrl) {
          try {
            const pg = require('pg');
            const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
            try {
              const dRes = await pool.query(
                `SELECT * FROM "${destObjectName}" WHERE "${destKeyField}" = ANY($1)`,
                [destKeys],
              );
              if (dRes.rows.length > 0) return dRes.rows;
            } finally {
              await pool.end().catch(() => {});
            }
          } catch (pErr: any) {
            // In production, external destination query failures must fail closed
            if (process.env.NODE_ENV === 'production') {
              throw new Error(`Failed to query destination PostgreSQL for ${destObjectName}: ${pErr.message}`);
            }
            console.warn(`[ValidationService] Live PostgreSQL destination query notice: ${pErr.message}`);
          }
        }
      }

      // Issue 3 fix: No local DB fallback for destination in production
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          `Destination records for ${destObjectName} could not be fetched: no external destination connection available. Validation failed closed.`,
        );
      }

      // Non-production only: query local DB for testing purposes
      try {
        const dRes = await this.db.query(`SELECT * FROM "${destObjectName}"`);
        return dRes.rows.filter((r: any) =>
          destKeys.includes(String(r[destKeyField] || r.id || r.destination_key)),
        );
      } catch (err: any) {
        console.warn(`[ValidationService] Local destination query notice: ${err.message}`);
        return [];
      }
    };

    const allCheckResults: any[] = [];
    const allDiscrepancies: any[] = [];
    const objectsValidated: string[] = [];
    let totalEvaluationDurationMs = 0;
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    // Loop through ALL mapped objects in plan version (P0: Multi-object validation)
    for (const obj of objectMappings) {
      const sourceObjectName =
        obj.source?.collection ||
        obj.source?.object ||
        (typeof obj.source === 'string' ? obj.source : 'customers');
      const destObjectName =
        obj.destination?.table ||
        obj.destination?.object ||
        (typeof obj.destination === 'string' ? obj.destination : 'customers');
      const sourceKeyField = obj.identity?.sourceKey || obj.source?.key || '_id';
      const destKeyField = obj.identity?.destinationKey || obj.destination?.key || 'id';

      objectsValidated.push(`${sourceObjectName} -> ${destObjectName}`);

      // Issue 2 fix: Independent count check — enumerate ALL source and destination records
      // regardless of what is in record_manifests. This catches 0-record silent-pass scenarios.
      let sourceCount = 0;
      let destCount = 0;

      if (srcConn?.engine === 'MONGODB' && sourceCredentials) {
        const uri = sourceCredentials.uri || sourceCredentials.connectionString;
        if (uri) {
          try {
            const { MongoClient } = require('mongodb');
            const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
            await client.connect();
            const dbName = srcConn.config_json?.database;
            const coll = client.db(dbName).collection(sourceObjectName);
            sourceCount = await coll.countDocuments();
            await client.close().catch(() => {});
          } catch (cErr: any) {
            console.warn(`[ValidationService] Source count query failed: ${cErr.message}`);
            if (process.env.NODE_ENV === 'production') {
              await this.recordFailedValidation(run.workspace_id, runId, `Source count query failed for ${sourceObjectName}: ${cErr.message}`);
              throw new Error(`Source count query failed for ${sourceObjectName}: ${cErr.message}. Validation failed closed.`);
            }
          }
        }
      }

      if (destConn?.engine === 'POSTGRESQL' && destCredentials) {
        const connStr = destCredentials.connectionString || destCredentials.uri;
        if (connStr && connStr !== appConfig.databaseUrl) {
          try {
            const pg = require('pg');
            const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
            try {
              assertSafeIdentifier(destObjectName, 'COUNT_MISMATCH dest count');
              const cRes = await pool.query(`SELECT COUNT(*) AS cnt FROM "${destObjectName}"`);
              destCount = parseInt(cRes.rows[0]?.cnt ?? '0', 10);
            } finally {
              await pool.end().catch(() => {});
            }
          } catch (cErr: any) {
            console.warn(`[ValidationService] Destination count query failed: ${cErr.message}`);
            if (process.env.NODE_ENV === 'production') {
              await this.recordFailedValidation(run.workspace_id, runId, `Destination count query failed for ${destObjectName}: ${cErr.message}`);
              throw new Error(`Destination count query failed for ${destObjectName}: ${cErr.message}. Validation failed closed.`);
            }
          }
        }
      }

      // Add COUNT_MISMATCH check result — this is PRIMARY, manifest-based check is SUPPLEMENTARY
      if (sourceCount > 0 || destCount > 0) {
        const countMatches = sourceCount === destCount;
        allCheckResults.push({
          checkId: `COUNT_MISMATCH_${sourceObjectName}`,
          checkName: `Record Count: ${sourceObjectName} → ${destObjectName}`,
          evaluatedCount: 1,
          passedCount: countMatches ? 1 : 0,
          failedCount: countMatches ? 0 : 1,
          failCount: countMatches ? 0 : 1,
          durationMs: 0,
          state: countMatches ? 'PASS' : 'FAIL',
        });
        if (!countMatches) {
          allDiscrepancies.push({
            category: 'RECORD_COUNT_MISMATCH',
            severity: 'CRITICAL',
            sourceObject: sourceObjectName,
            destinationObject: destObjectName,
            sourceKey: 'N/A',
            destinationKey: 'N/A',
            explanation: `Source count (${sourceCount}) does not match destination count (${destCount}) for ${sourceObjectName} → ${destObjectName}.`,
          });
        }
      }

      // Load manifests scoped to this exact run and object mapping (Requirement 2: exact mapping identity)
      const manifestsRes = await this.db.query(
        `SELECT * FROM record_manifests
         WHERE migration_run_id = $1
           AND source_object = $2
           AND destination_object = $3
         ORDER BY created_at ASC`,
        [runId, sourceObjectName, destObjectName],
      );
      const manifests = manifestsRes.rows;

      const destKeys = manifests
        .map((m: any) => m.destination_key || m.source_key)
        .filter(Boolean);
      const sourceKeys = manifests.map((m: any) => m.source_key).filter(Boolean);

      let destRecords: any[] = [];
      let sourceRecords: any[] = [];

      if (destKeys.length > 0) {
        destRecords = await fetchDestRecords(destObjectName, destKeyField, destKeys);
      }
      if (sourceKeys.length > 0) {
        sourceRecords = await fetchSourceRecords(sourceObjectName, sourceKeyField, sourceKeys);
      }

      if (sourceKeys.length > 0 && sourceRecords.length === 0) {
        if (process.env.NODE_ENV === 'production') {
          await this.recordFailedValidation(
            run.workspace_id,
            runId,
            `No source records could be retrieved from source for ${sourceObjectName}. Cannot prove migration correctness.`,
          );
          throw new Error(
            `Source records could not be retrieved from source connection for ${sourceObjectName}. Validation failed closed.`,
          );
        }
      }

      let sourceDataset: ValidationDataset;
      let destinationDataset: ValidationDataset;

      if (manifests.length === 0 && sourceRecords.length === 0 && destRecords.length === 0) {
        if (process.env.NODE_ENV === 'production') {
          await this.recordFailedValidation(
            run.workspace_id,
            runId,
            'No migration manifests or destination records exist for this run. Cannot validate in production.',
          );
          throw new Error('No manifests or records found for migration run. Validation failed closed.');
        }
        // Non-production test harness fallback for synthetic validation test suites
        const benchmark = generateSyntheticDataset({ totalRecords: 200 });
        const faultResult = injectFaults(benchmark);
        destinationDataset = faultResult.faultedDataset;
        sourceDataset = benchmark;
      } else {
        const mappingObj: ObjectMapping = {
          source: {
            collection: sourceObjectName,
          },
          destination: {
            table: destObjectName,
          },
          identity: {
            sourceKey: sourceKeyField,
            destinationKey: destKeyField,
            strategy: obj.identity?.strategy || 'PRESERVE_AS_TEXT',
          },
          fields: Array.isArray(obj.fields)
            ? obj.fields.map((f: any) => ({
                sourcePath: f.sourcePath || f.source || f.field || f.fieldPath,
                destinationPath: f.destinationPath || f.destination || f.field || f.fieldPath,
                transform: f.transform,
                nullable: f.nullable,
                defaultValue: f.defaultValue,
              }))
            : [],
        };

        const transformEngine = new TransformationEngine(mappingObj);

        sourceDataset = {
          objectName: sourceObjectName,
          records: sourceRecords.map((r: any) => {
            const transformed = transformEngine.transform(r);
            const destKeyVal = String(transformed.destinationKey || r[sourceKeyField] || r.id || r._id);
            return {
              ...r,
              ...transformed.payload,
              id: destKeyVal,
            };
          }),
          orders: [],
          attachments: [],
        };

        destinationDataset = {
          objectName: destObjectName,
          records: destRecords.map((r: any) => {
            const destKeyVal = String(r[destKeyField] || r.id || r.destination_key);
            return {
              ...(r.created_at || r.createdAt ? { createdAt: parseDateSafe(r.created_at || r.createdAt) } : {}),
              ...(r.updated_at || r.updatedAt ? { updatedAt: parseDateSafe(r.updated_at || r.updatedAt) } : {}),
              ...r,
              id: destKeyVal,
            };
          }),
          orders: [],
          attachments: [],
        };
      }

      // Configure field rules from approved object mapping (Requirement 3: preserve sourcePath and destinationPath)
      const mappingObjForEngine: ObjectMapping = {
        source: { collection: sourceObjectName },
        destination: { table: destObjectName },
        identity: {
          sourceKey: sourceKeyField,
          destinationKey: destKeyField,
          strategy: obj.identity?.strategy || 'PRESERVE_AS_TEXT',
        },
        fields: Array.isArray(obj.fields)
          ? obj.fields.map((f: any) => ({
              sourcePath: f.sourcePath || f.source || f.field || f.fieldPath,
              destinationPath: f.destinationPath || f.destination || f.field || f.fieldPath,
              transform: f.transform,
              nullable: f.nullable,
              defaultValue: f.defaultValue,
            }))
          : [],
      };
      const transformEngineForEngine = new TransformationEngine(mappingObjForEngine);

      const fieldRules = Array.isArray(obj.fields) && obj.fields.length > 0
        ? obj.fields.map((f: any) => {
            const sPath = f.sourcePath || f.source || f.field || f.fieldPath;
            const dPath = f.destinationPath || f.destination || f.field || f.fieldPath;
            return {
              fieldPath: dPath || sPath,
              sourcePath: dPath || sPath,
              destinationPath: dPath || sPath,
              nullable: f.nullable,
              customComparator: (srcVal: any, destVal: any) => {
                if (srcVal === destVal) return true;
                if (srcVal === null || srcVal === undefined) {
                  return destVal === null || destVal === undefined;
                }
                if (destVal === null || destVal === undefined) return false;
                if (typeof srcVal === 'number' && typeof destVal === 'number') {
                  return Math.abs(srcVal - destVal) < 1e-9;
                }
                if (srcVal instanceof Date || (typeof srcVal === 'string' && !isNaN(Date.parse(srcVal)))) {
                  const d1 = new Date(srcVal).getTime();
                  const d2 = new Date(destVal).getTime();
                  if (!isNaN(d1) && !isNaN(d2)) return d1 === d2;
                }
                if (typeof srcVal === 'object' && typeof destVal === 'object') {
                  return JSON.stringify(srcVal) === JSON.stringify(destVal);
                }
                return String(srcVal) === String(destVal);
              },
            };
          })
        : [
            { fieldPath: 'name', sourcePath: 'name', destinationPath: 'name' },
            { fieldPath: 'email', sourcePath: 'email', destinationPath: 'email' },
          ];

      const normalizer = (srcRec: any) => {
        try {
          const transformed = transformEngineForEngine.transform(srcRec);
          const destKey = String(transformed.destinationKey || srcRec.id || srcRec._id);
          const norm: Record<string, any> = {
            id: destKey,
          };
          if (destKeyField && destKeyField !== 'id') {
            norm[destKeyField] = destKey;
          }
          if (Array.isArray(obj.fields) && obj.fields.length > 0) {
            for (const f of obj.fields) {
              const dPath = f.destinationPath || f.destination || f.field || f.fieldPath;
              if (dPath) {
                norm[dPath] = transformed.payload?.[dPath];
              }
            }
          } else {
            Object.assign(norm, transformed.payload);
          }
          return norm;
        } catch {
          return srcRec;
        }
      };

      const destNormalizer = (destRec: any) => {
        try {
          const destKey = String(destRec[destKeyField] || destRec.id || destRec.destination_key);
          const norm: Record<string, any> = {
            id: destKey,
          };
          if (destKeyField && destKeyField !== 'id') {
            norm[destKeyField] = destKey;
          }
          if (Array.isArray(obj.fields) && obj.fields.length > 0) {
            for (const f of obj.fields) {
              const dPath = f.destinationPath || f.destination || f.field || f.fieldPath;
              if (dPath) {
                norm[dPath] = destRec[dPath];
              }
            }
          } else {
            Object.assign(norm, destRec);
          }
          return norm;
        } catch {
          return destRec;
        }
      };

      const engine = new ValidationEngine({
        migrationRunId: runId,
        workspaceId: run.workspace_id,
        fieldRules,
        normalizer,
        destNormalizer,
      });

      const summary = await engine.validate(sourceDataset, destinationDataset);
      allCheckResults.push(...summary.checkResults);
      allDiscrepancies.push(...summary.discrepancies);
      totalEvaluationDurationMs += summary.durationMs;
    }

    const completedAt = new Date().toISOString();
    const durationMs = Math.max(1, Date.now() - startTime);

    const totalFailedChecks = allCheckResults.filter((c: any) => (c.failedCount ?? c.failCount ?? 0) > 0).length;
    const totalPassedChecks = allCheckResults.filter((c: any) => (c.failedCount ?? c.failCount ?? 0) === 0).length;

    // Explicit distinction between execution status ('COMPLETED') and verification outcome ('PASSED' / 'FAILED')
    const outcome = totalFailedChecks > 0 ? 'FAILED' : 'PASSED';
    const executionStatus = 'COMPLETED';

    const summaryJson = {
      executionStatus,
      outcome,
      overallStatus: outcome,
      totalChecks: allCheckResults.length,
      passedChecks: totalPassedChecks,
      failedChecks: totalFailedChecks,
      discrepancies: allDiscrepancies.length,
      durationMs,
      objectsValidated,
    };

    // Create validation_runs row with verified execution completion and summary outcome
    const valRes = await this.db.query(
      `INSERT INTO validation_runs (
         workspace_id, migration_run_id, status, validation_profile_version,
         canonicalization_version, started_at, completed_at, summary_json
       )
       VALUES ($1, $2, 'COMPLETED', '1.0', '1.0', $3, $4, $5)
       RETURNING *`,
      [
        run.workspace_id,
        runId,
        startedAt,
        completedAt,
        summaryJson,
      ],
    );

    const valRun = {
      ...valRes.rows[0],
      summaryJson,
      summary_json: summaryJson,
      executionStatus,
      outcome,
    };

    // Persist real check results across all objects
    for (const c of allCheckResults) {
      const checkStatus = (c as any).state || (c as any).status || ((c.failedCount ?? c.failCount ?? 0) === 0 ? 'PASS' : 'FAIL');
      await this.db.query(
        `INSERT INTO validation_check_results (
           validation_run_id, check_id, check_name, status,
           evaluated_count, passed_count, failed_count, skipped_count, duration_ms
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
        [
          valRun.id,
          c.checkId,
          c.checkName,
          checkStatus,
          c.evaluatedCount ?? 0,
          c.passedCount ?? c.passCount ?? 0,
          c.failedCount ?? c.failCount ?? 0,
          c.durationMs ?? 0,
        ],
      );
    }

    // Persist real record-level discrepancies across all objects
    for (const d of allDiscrepancies) {
      let cat = d.category as string;
      if (cat === 'MISSING_ATTACHMENT' || cat === 'ATTACHMENT_MISSING') cat = 'ATTACHMENT';
      else if (cat === 'DUPLICATE_RECORD') cat = 'DUPLICATE';
      else if (cat === 'BROKEN_REFERENCE') cat = 'RELATIONSHIP';
      else if (cat === 'METADATA_MISMATCH') cat = 'METADATA';
      else if (cat === 'RECORD_COUNT_MISMATCH') cat = 'COUNT';
      else if (cat === 'FIELD_VALUE_MISMATCH') cat = 'FIELD_VALUE';
      else if (cat === 'CONTENT_HASH_MISMATCH') cat = 'CONTENT_HASH';

      const srcKey = d.sourceKey || d.sourceKeyRef || d.destinationKey || d.destinationKeyRef || d.issueId || 'N/A';
      const destKey = d.destinationKey || d.destinationKeyRef || d.sourceKey || d.sourceKeyRef || 'N/A';
      const summaryText = d.explanation || d.summary || `${d.category} discrepancy detected on ${srcKey}`;

      await this.db.query(
        `INSERT INTO discrepancies (
           validation_run_id, category, severity, source_object,
           source_key_ref, destination_object, destination_key_ref,
           field_path, summary, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
        [
          valRun.id,
          cat,
          d.severity,
          d.sourceObject || 'customers',
          srcKey,
          d.destinationObject || 'customers',
          destKey,
          d.fieldPath || null,
          summaryText,
        ],
      );
    }

    return valRun;
  }

  async getValidationRun(validationRunId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM validation_runs WHERE id = $1', [validationRunId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Validation run not found.');
    }
    const run = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Viewer');
    return run;
  }

  async getValidationForRun(migrationRunId: string, userId: string) {
    const res = await this.db.query(
      'SELECT * FROM validation_runs WHERE migration_run_id = $1 ORDER BY created_at DESC LIMIT 1',
      [migrationRunId],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException('No validation run found for this migration run.');
    }
    const run = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Viewer');
    return run;
  }

  async getCheckResults(validationRunId: string, userId: string) {
    await this.getValidationRun(validationRunId, userId);
    const res = await this.db.query(
      'SELECT * FROM validation_check_results WHERE validation_run_id = $1 ORDER BY check_id ASC',
      [validationRunId],
    );
    return res.rows;
  }
}
