import { ToolExecutionRequest, ToolExecutionResponse, ToolExecutionGuard } from './tool-guard.js';
import { v4 as uuidv4 } from 'uuid';

function assertSafeIdentifier(name: string, context: string): void {
  if (!name || typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier in ${context}: "${name}"`);
  }
}

export class ToolCatalog {
  private static mockSnapshots: Map<string, any> = new Map();
  private static mockDiscrepancies: Map<string, any[]> = new Map();
  private static mockRuns: Map<string, any> = new Map();
  private static db: any = null;

  public static setDatabaseService(db: any): void {
    this.db = db;
  }

  /**
   * Seed mock data for offline test execution when no database is configured.
   */
  public static seedSnapshot(id: string, snapshot: any): void {
    this.mockSnapshots.set(id, snapshot);
  }

  public static seedDiscrepancies(runId: string, discrepancies: any[]): void {
    this.mockDiscrepancies.set(runId, discrepancies);
  }

  public static seedRun(runId: string, run: any): void {
    this.mockRuns.set(runId, run);
  }

  public static clearMocks(): void {
    this.mockSnapshots.clear();
    this.mockDiscrepancies.clear();
    this.mockRuns.clear();
  }

  /**
   * Execute an allowlisted tool with full authorization and safety guards.
   */
  public static async executeTool(
    request: ToolExecutionRequest
  ): Promise<ToolExecutionResponse> {
    // 1. Guard check
    const validation = ToolExecutionGuard.validateRequest(request);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      };
    }

    const { toolName, input, context } = request;

    try {
      let rawResult: any;

      switch (toolName) {
        case 'get_schema_snapshot': {
          const snapshotId = input.snapshotId as string;
          if (this.db) {
            const res = await this.db.query(
              'SELECT * FROM schema_snapshots WHERE id = $1 AND workspace_id = $2',
              [snapshotId, context.workspaceId],
            );
            if (res.rows.length > 0) {
              rawResult = res.rows[0].snapshot_json;
              break;
            } else {
              rawResult = {
                status: 'NOT_FOUND',
                notFound: true,
                snapshotId,
                message: `Snapshot ${snapshotId} not found in workspace.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              snapshotId,
              message: 'Database service unavailable.',
            };
            break;
          }
          const found = this.mockSnapshots.get(snapshotId);
          if (found) {
            rawResult = found;
          } else {
            rawResult = {
              status: 'NOT_FOUND',
              notFound: true,
              snapshotId,
              message: `Snapshot ${snapshotId} not found in workspace.`,
            };
          }
          break;
        }

        case 'get_profile_summary': {
          const snapshotId = input.snapshotId as string;
          if (this.db) {
            // First enforce workspace ownership of the referenced schema snapshot
            const ssRes = await this.db.query(
              'SELECT id FROM schema_snapshots WHERE id = $1 AND workspace_id = $2',
              [snapshotId, context.workspaceId],
            );
            if (ssRes.rows.length === 0) {
              rawResult = {
                status: 'NOT_FOUND',
                snapshotId,
                message: `Snapshot ${snapshotId} not found in workspace.`,
              };
              break;
            }

            const res = await this.db.query(
              'SELECT * FROM profile_runs WHERE schema_snapshot_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1',
              [snapshotId, context.workspaceId],
            );
            if (res.rows.length > 0) {
              rawResult = res.rows[0].summary_json;
              break;
            } else {
              rawResult = {
                status: 'UNAVAILABLE',
                snapshotId,
                message: `Profile summary for snapshot ${snapshotId} is unavailable. No profile run has been executed for this snapshot.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              snapshotId,
              message: 'Database service unavailable.',
            };
            break;
          }
          const found = this.mockSnapshots.get(`profile_${snapshotId}`);
          if (found) {
            rawResult = found;
          } else {
            rawResult = {
              status: 'UNAVAILABLE',
              snapshotId,
              message: `Profile summary for snapshot ${snapshotId} is unavailable. No profile run has been executed for this snapshot.`,
            };
          }
          break;
        }

        case 'get_connector_capabilities': {
          const engine = input.engine as string;
          rawResult =
            engine === 'MONGODB'
              ? {
                  engine: 'MONGODB',
                  supportedSource: true,
                  supportedDestination: false,
                  supportsStreaming: true,
                  supportsCdcChangeStreams: true,
                  supportedBsonTypes: ['ObjectId', 'String', 'Date', 'Int32', 'Int64', 'Decimal128', 'Document', 'Array'],
                }
              : {
                  engine: 'POSTGRESQL',
                  supportedSource: true,
                  supportedDestination: true,
                  supportsTransactions: true,
                  supportsUpsert: true,
                  supportsJsonb: true,
                  supportedDataTypes: ['text', 'varchar', 'integer', 'bigint', 'numeric', 'timestamp with time zone', 'jsonb', 'uuid'],
                };
          break;
        }

        case 'get_mapping_version': {
          const versionId = input.mappingVersionId as string;
          if (this.db) {
            const res = await this.db.query(
              'SELECT * FROM mapping_versions WHERE id = $1 AND workspace_id = $2',
              [versionId, context.workspaceId],
            );
            if (res.rows.length > 0) {
              const row = res.rows[0];
              const parsed = typeof row.mapping_json === 'string' ? JSON.parse(row.mapping_json) : row.mapping_json;
              rawResult = {
                versionId: row.id,
                version: row.version,
                mapping: parsed,
                rules: parsed?.rules || parsed?.objects || [],
              };
              break;
            } else {
              rawResult = {
                status: 'NOT_FOUND',
                versionId,
                message: `Mapping version ${versionId} not found in workspace.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              versionId,
              message: 'Database service unavailable.',
            };
            break;
          }
          rawResult = {
            status: 'NOT_FOUND',
            versionId,
            message: `Mapping version ${versionId} not found in workspace.`,
          };
          break;
        }

        case 'preview_transform': {
          const sample = input.sampleRecord as Record<string, any>;
          // Sandboxed transform execution
          const transformed: Record<string, any> = {};
          for (const [k, v] of Object.entries(sample)) {
            if (typeof v === 'string') {
              transformed[k] = v.trim();
            } else {
              transformed[k] = v;
            }
          }
          rawResult = {
            success: true,
            inputSample: sample,
            outputRecord: transformed,
            appliedOperations: ['TRIM_STRING'],
            warnings: [],
          };
          break;
        }

        case 'get_run_summary': {
          const runId = input.runId as string;
          if (this.db) {
            const runRes = await this.db.query(
              'SELECT * FROM migration_runs WHERE id = $1 AND workspace_id = $2',
              [runId, context.workspaceId],
            );
            if (runRes.rows.length > 0) {
              const run = runRes.rows[0];
              const batchesRes = this.db.isDbConnected
                ? await this.db.query(
                    `SELECT 
                       COUNT(*) as total_batches,
                       COALESCE(SUM(mb.records_read), 0) as total_read,
                       COALESCE(SUM(mb.records_written), 0) as total_written,
                       COALESCE(SUM(mb.records_failed), 0) as total_failed,
                       COUNT(*) FILTER (WHERE mb.status = 'COMMITTED') as committed_batches,
                       COUNT(*) FILTER (WHERE mb.status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN')) as failed_batches,
                       COUNT(*) FILTER (WHERE mb.status = 'RUNNING') as active_batches
                     FROM migration_batches mb
                     JOIN migration_runs mr ON mr.id = mb.migration_run_id
                     WHERE mb.migration_run_id = $1 AND mr.workspace_id = $2`,
                    [runId, context.workspaceId],
                  )
                : await this.db.query(
                    `SELECT 
                       COUNT(*) as total_batches,
                       COALESCE(SUM(records_read), 0) as total_read,
                       COALESCE(SUM(records_written), 0) as total_written,
                       COALESCE(SUM(records_failed), 0) as total_failed,
                       COUNT(*) FILTER (WHERE status = 'COMMITTED') as committed_batches,
                       COUNT(*) FILTER (WHERE status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN')) as failed_batches,
                       COUNT(*) FILTER (WHERE status = 'RUNNING') as active_batches
                     FROM migration_batches WHERE migration_run_id = $1`,
                    [runId],
                  );
              const b = batchesRes.rows[0] || {};
              rawResult = {
                runId: run.id,
                status: run.status,
                totalRecords: parseInt(b.total_read || '0', 10),
                processedRecords: parseInt(b.total_written || '0', 10),
                failedRecords: parseInt(b.total_failed || '0', 10),
                activeBatches: parseInt(b.active_batches || '0', 10),
                failedBatches: parseInt(b.failed_batches || '0', 10),
                committedBatches: parseInt(b.committed_batches || '0', 10),
                startedAt: run.started_at,
                completedAt: run.completed_at,
              };
              break;
            } else {
              rawResult = {
                status: 'NOT_FOUND',
                runId,
                message: `Migration run ${runId} not found in workspace.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              runId,
              message: 'Database service unavailable.',
            };
            break;
          }
          const found = this.mockRuns.get(runId);
          if (found) {
            rawResult = found;
          } else {
            rawResult = {
              status: 'NOT_FOUND',
              runId,
              message: `Migration run ${runId} not found in workspace.`,
            };
          }
          break;
        }

        case 'get_batch_errors': {
          const runId = input.runId as string;
          const batchId = input.batchId as string | undefined;
          const limit = (input.limit as number) || 50;
          if (this.db) {
            // Enforce workspace ownership on the migration run first
            const runRes = await this.db.query(
              'SELECT id FROM migration_runs WHERE id = $1 AND workspace_id = $2',
              [runId, context.workspaceId],
            );
            if (runRes.rows.length === 0) {
              rawResult = {
                status: 'NOT_FOUND',
                runId,
                batchErrors: [],
                total: 0,
                message: `Migration run ${runId} not found in workspace.`,
              };
              break;
            }

            let batchRes: any;
            if (this.db.isDbConnected) {
              if (batchId) {
                batchRes = await this.db.query(
                  `SELECT mb.batch_key, mb.status, mb.records_failed, mb.error_summary, mb.attempt_count 
                   FROM migration_batches mb
                   JOIN migration_runs mr ON mr.id = mb.migration_run_id
                   WHERE mb.migration_run_id = $1 AND mr.workspace_id = $2 AND mb.batch_key = $3
                     AND (mb.status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN') OR mb.records_failed > 0)
                   ORDER BY mb.sequence_no ASC LIMIT $4`,
                  [runId, context.workspaceId, batchId, limit],
                );
              } else {
                batchRes = await this.db.query(
                  `SELECT mb.batch_key, mb.status, mb.records_failed, mb.error_summary, mb.attempt_count 
                   FROM migration_batches mb
                   JOIN migration_runs mr ON mr.id = mb.migration_run_id
                   WHERE mb.migration_run_id = $1 AND mr.workspace_id = $2
                     AND (mb.status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN') OR mb.records_failed > 0)
                   ORDER BY mb.sequence_no ASC LIMIT $3`,
                  [runId, context.workspaceId, limit],
                );
              }
            } else {
              if (batchId) {
                batchRes = await this.db.query(
                  `SELECT batch_key, status, records_failed, error_summary, attempt_count 
                   FROM migration_batches 
                   WHERE migration_run_id = $1 AND batch_key = $2 AND (status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN') OR records_failed > 0)
                   ORDER BY sequence_no ASC LIMIT $3`,
                  [runId, batchId, limit],
                );
              } else {
                batchRes = await this.db.query(
                  `SELECT batch_key, status, records_failed, error_summary, attempt_count 
                   FROM migration_batches 
                   WHERE migration_run_id = $1 AND (status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN') OR records_failed > 0)
                   ORDER BY sequence_no ASC LIMIT $2`,
                  [runId, limit],
                );
              }
            }

            if (batchRes.rows.length > 0) {
              rawResult = {
                runId,
                batchErrors: batchRes.rows.map((r: any) => ({
                  batchId: r.batch_key,
                  status: r.status,
                  errorCode: r.error_summary?.code || 'BATCH_EXECUTION_ERROR',
                  errorMessage: r.error_summary?.message || 'Batch encountered failures during execution',
                  retryCount: r.attempt_count || 0,
                  isRetryable: r.status === 'FAILED_RETRYABLE',
                })),
                total: batchRes.rows.length,
              };
              break;
            } else {
              rawResult = {
                runId,
                batchErrors: [],
                total: 0,
                message: `No batch errors found for migration run ${runId}.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              runId,
              batchErrors: [],
              total: 0,
              message: 'Database service unavailable.',
            };
            break;
          }
          rawResult = {
            runId,
            batchErrors: [],
            total: 0,
            message: `No batch errors found for migration run ${runId}.`,
          };
          break;
        }

        case 'get_discrepancy_evidence': {
          const vRunId = input.validationRunId as string;
          const limit = (input.limit as number) || 50;
          if (this.db) {
            // First verify that the validation run exists and belongs to this workspace
            const vRunRes = await this.db.query(
              'SELECT id FROM validation_runs WHERE id = $1 AND workspace_id = $2',
              [vRunId, context.workspaceId],
            );
            if (vRunRes.rows.length === 0) {
              rawResult = {
                status: 'NOT_FOUND',
                validationRunId: vRunId,
                discrepancies: [],
                total: 0,
                message: `Validation run ${vRunId} not found in workspace.`,
              };
              break;
            }

            const discRes = this.db.isDbConnected
              ? await this.db.query(
                  `SELECT d.* FROM discrepancies d
                   JOIN validation_runs vr ON vr.id = d.validation_run_id
                   WHERE d.validation_run_id = $1 AND vr.workspace_id = $2
                   ORDER BY d.created_at ASC LIMIT $3`,
                  [vRunId, context.workspaceId, limit],
                )
              : await this.db.query(
                  `SELECT * FROM discrepancies 
                   WHERE validation_run_id = $1
                   ORDER BY created_at ASC LIMIT $2`,
                  [vRunId, limit],
                );

            if (discRes.rows.length > 0) {
              rawResult = {
                validationRunId: vRunId,
                discrepancies: discRes.rows.map((r: any) => ({
                  id: r.id,
                  validationRunId: r.validation_run_id,
                  sourceKey: r.source_key_ref || r.source_key,
                  destinationKey: r.destination_key_ref || r.destination_key,
                  category: r.category,
                  severity: r.severity,
                  expectedValue: r.expected_value,
                  actualValue: r.actual_value,
                  explanation: r.summary || r.explanation,
                })),
                total: discRes.rows.length,
              };
              break;
            } else {
              rawResult = {
                validationRunId: vRunId,
                discrepancies: [],
                total: 0,
                message: `No discrepancy evidence found for validation run ${vRunId}.`,
              };
              break;
            }
          }
          if (process.env.NODE_ENV === 'production') {
            rawResult = {
              status: 'UNAVAILABLE',
              validationRunId: vRunId,
              discrepancies: [],
              total: 0,
              message: 'Database service unavailable.',
            };
            break;
          }
          const list = this.mockDiscrepancies.get(vRunId);
          if (list) {
            rawResult = {
              validationRunId: vRunId,
              discrepancies: list.slice(0, limit),
              total: list.length,
            };
          } else {
            rawResult = {
              status: 'NOT_FOUND',
              validationRunId: vRunId,
              discrepancies: [],
              total: 0,
              message: `No discrepancy evidence found for validation run ${vRunId}.`,
            };
          }
          break;
        }

        case 'compare_sample_records': {
          let srcRec = input.sourceRecord as Record<string, any> | undefined;
          let dstRec = input.destinationRecord as Record<string, any> | undefined;

          if (!srcRec && !dstRec && input.sourceRecordId && input.destinationRecordId) {
            if (this.db) {
              let mRes: any;
              if (this.db.isDbConnected) {
                mRes = await this.db.query(
                  `SELECT rm.* FROM record_manifests rm
                   JOIN migration_runs mr ON mr.id = rm.migration_run_id
                   WHERE rm.source_key = $1 AND rm.destination_key = $2 AND mr.workspace_id = $3 LIMIT 1`,
                  [input.sourceRecordId, input.destinationRecordId, context.workspaceId],
                );
              } else {
                const manifestRes = await this.db.query(
                  `SELECT * FROM record_manifests WHERE source_key = $1 AND destination_key = $2 LIMIT 1`,
                  [input.sourceRecordId, input.destinationRecordId],
                );
                if (manifestRes.rows.length > 0) {
                  const runRes = await this.db.query(
                    `SELECT id FROM migration_runs WHERE id = $1 AND workspace_id = $2`,
                    [manifestRes.rows[0].migration_run_id, context.workspaceId],
                  );
                  if (runRes.rows.length > 0) {
                    mRes = manifestRes;
                  } else {
                    mRes = { rows: [], rowCount: 0 };
                  }
                } else {
                  mRes = { rows: [], rowCount: 0 };
                }
              }

              if (mRes.rows.length === 0) {
                rawResult = {
                  status: 'NOT_FOUND',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Sample records ${input.sourceRecordId} and ${input.destinationRecordId} not found in workspace evidence.`,
                };
                break;
              }

              const manifest = mRes.rows[0];

              // Retrieve actual source and destination records via authorized connections in workspace
              const runRes = await this.db.query(
                `SELECT mr.plan_version_id, mr.workspace_id, mpv.source_connection_id, mpv.destination_connection_id, mpv.mapping_version_id
                 FROM migration_runs mr
                 JOIN migration_plan_versions mpv ON mpv.id = mr.plan_version_id
                 WHERE mr.id = $1 AND mr.workspace_id = $2`,
                [manifest.migration_run_id, context.workspaceId],
              );

              if (runRes.rows.length === 0) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: 'Authorized plan version and connections unavailable for record retrieval.',
                };
                break;
              }

              const planInfo = runRes.rows[0];

              // Verify connections belong to the authorized workspace
              const connRes = await this.db.query(
                `SELECT id, engine, connection_role, config_json, credential_version
                 FROM connections
                 WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
                [[planInfo.source_connection_id, planInfo.destination_connection_id], context.workspaceId],
              );

              const srcConn = connRes.rows.find((c: any) => c.id === planInfo.source_connection_id);
              const dstConn = connRes.rows.find((c: any) => c.id === planInfo.destination_connection_id);

              if (!srcConn || !dstConn) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: 'Authorized source or destination connection not found in workspace.',
                };
                break;
              }

              // Retrieve decrypted credentials from connection_secrets
              const getDecryptedCreds = async (connectionId: string, version: number) => {
                const sRes = await this.db.query(
                  'SELECT * FROM connection_secrets WHERE connection_id = $1 AND version = $2',
                  [connectionId, version],
                );
                if (sRes.rows.length === 0) return null;
                const row = sRes.rows[0];
                const { CryptoUtil } = require('../../common/crypto/crypto.util');
                const decryptedJson = CryptoUtil.decrypt({
                  encryptedData: row.encrypted_payload,
                  iv: row.iv,
                  authTag: row.auth_tag,
                });
                return JSON.parse(decryptedJson);
              };

              let srcCreds: any = null;
              let dstCreds: any = null;
              try {
                srcCreds = await getDecryptedCreds(srcConn.id, srcConn.credential_version || 1);
                dstCreds = await getDecryptedCreds(dstConn.id, dstConn.credential_version || 1);
              } catch (err: any) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Failed to decrypt credentials for connection: ${err.message}`,
                };
                break;
              }

              if (!srcCreds || !dstCreds) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: 'Authorized connection credentials unavailable in vault.',
                };
                break;
              }

              // Retrieve identity key names from mapping version
              let sourceKeyField = '_id';
              let destKeyField = 'id';
              if (planInfo.mapping_version_id) {
                const mapRes = await this.db.query(
                  'SELECT mapping_json FROM mapping_versions WHERE id = $1 AND workspace_id = $2',
                  [planInfo.mapping_version_id, context.workspaceId],
                );
                if (mapRes.rows.length > 0) {
                  const mJson = typeof mapRes.rows[0].mapping_json === 'string'
                    ? JSON.parse(mapRes.rows[0].mapping_json)
                    : mapRes.rows[0].mapping_json;
                  const objs = Array.isArray(mJson.objects) ? mJson.objects : (mJson.source ? [mJson] : []);
                  const matchedObj = objs.find((o: any) =>
                    (o.source?.collection || o.source?.object || o.source) === manifest.source_object &&
                    (o.destination?.table || o.destination?.object || o.destination) === manifest.destination_object
                  );
                  if (matchedObj?.identity?.sourceKey) sourceKeyField = matchedObj.identity.sourceKey;
                  if (matchedObj?.identity?.destinationKey) destKeyField = matchedObj.identity.destinationKey;
                }
              }

              // Validate all dynamic SQL identifiers before querying
              try {
                assertSafeIdentifier(manifest.destination_object, 'destination object');
                assertSafeIdentifier(destKeyField, 'destination key');
                assertSafeIdentifier(manifest.source_object, 'source object');
                assertSafeIdentifier(sourceKeyField, 'source key');
              } catch (idErr: any) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Invalid or unsafe identifier: ${idErr.message}`,
                };
                break;
              }

              let liveSrc: any = null;
              let liveDst: any = null;
              let srcQueried = false;
              let dstQueried = false;

              // Query destination PostgreSQL record
              const dstConnStr = dstCreds.connectionString || dstCreds.uri || dstCreds.url;
              if (dstConn.engine === 'POSTGRESQL' && dstConnStr) {
                try {
                  const pg = require('pg');
                  const pool = new pg.Pool({ connectionString: dstConnStr, connectionTimeoutMillis: 2000 });
                  try {
                    const qRes = await pool.query(
                      `SELECT * FROM "${manifest.destination_object}" WHERE "${destKeyField}" = $1 LIMIT 1`,
                      [input.destinationRecordId],
                    );
                    dstQueried = true;
                    if (qRes.rows.length > 0) liveDst = qRes.rows[0];
                  } finally {
                    await pool.end().catch(() => {});
                  }
                } catch (err: any) {
                  rawResult = {
                    status: 'UNAVAILABLE',
                    sourceRecordId: input.sourceRecordId,
                    destinationRecordId: input.destinationRecordId,
                    message: `Live destination query failed: ${err.message}`,
                  };
                  break;
                }
              } else {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Live record retrieval unsupported for destination engine '${dstConn.engine}'.`,
                };
                break;
              }

              // Query source MongoDB or PostgreSQL record
              const srcConnStr = srcCreds.uri || srcCreds.connectionString || srcCreds.url;
              if (srcConn.engine === 'MONGODB' && srcConnStr) {
                try {
                  const { MongoClient, ObjectId } = require('mongodb');
                  const client = new MongoClient(srcConnStr, { serverSelectionTimeoutMS: 2000 });
                  try {
                    await client.connect();
                    const dbName = srcConn.config_json?.database;
                    const coll = client.db(dbName).collection(manifest.source_object);
                    let filter: any;
                    const sIdStr = String(input.sourceRecordId);
                    if (sourceKeyField === '_id' && /^[0-9a-fA-F]{24}$/.test(sIdStr)) {
                      filter = { $or: [{ _id: new ObjectId(sIdStr) }, { _id: sIdStr }] };
                    } else {
                      filter = { [sourceKeyField]: sIdStr };
                    }
                    liveSrc = await coll.findOne(filter);
                    srcQueried = true;
                  } finally {
                    await client.close().catch(() => {});
                  }
                } catch (err: any) {
                  rawResult = {
                    status: 'UNAVAILABLE',
                    sourceRecordId: input.sourceRecordId,
                    destinationRecordId: input.destinationRecordId,
                    message: `Live source query failed: ${err.message}`,
                  };
                  break;
                }
              } else if (srcConn.engine === 'POSTGRESQL' && srcConnStr) {
                try {
                  const pg = require('pg');
                  const pool = new pg.Pool({ connectionString: srcConnStr, connectionTimeoutMillis: 2000 });
                  try {
                    const qRes = await pool.query(
                      `SELECT * FROM "${manifest.source_object}" WHERE "${sourceKeyField}" = $1 LIMIT 1`,
                      [input.sourceRecordId],
                    );
                    srcQueried = true;
                    if (qRes.rows.length > 0) liveSrc = qRes.rows[0];
                  } finally {
                    await pool.end().catch(() => {});
                  }
                } catch (err: any) {
                  rawResult = {
                    status: 'UNAVAILABLE',
                    sourceRecordId: input.sourceRecordId,
                    destinationRecordId: input.destinationRecordId,
                    message: `Live source query failed: ${err.message}`,
                  };
                  break;
                }
              } else {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Live record retrieval unsupported for source engine '${srcConn.engine}'.`,
                };
                break;
              }

              if (!srcQueried || !dstQueried) {
                rawResult = {
                  status: 'UNAVAILABLE',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: 'Live record retrieval unsupported or could not be completed.',
                };
                break;
              }

              if (!liveSrc || !liveDst) {
                rawResult = {
                  status: 'NOT_FOUND',
                  sourceRecordId: input.sourceRecordId,
                  destinationRecordId: input.destinationRecordId,
                  message: `Record ${!liveSrc ? input.sourceRecordId : input.destinationRecordId} not found in live database.`,
                };
                break;
              }

              srcRec = liveSrc;
              dstRec = liveDst;
            } else {
              rawResult = {
                status: 'NOT_FOUND',
                sourceRecordId: input.sourceRecordId,
                destinationRecordId: input.destinationRecordId,
                message: `Sample records not provided or found for comparison.`,
              };
              break;
            }
          }

          if (!srcRec && !dstRec) {
            rawResult = {
              status: 'NOT_FOUND',
              sourceRecordId: input.sourceRecordId,
              destinationRecordId: input.destinationRecordId,
              message: `Sample records not provided or found for comparison.`,
            };
            break;
          }

          const matchedFields: string[] = [];
          const divergentFields: Array<{
            field: string;
            sourceValue: any;
            destinationValue: any;
            differenceReason: string;
          }> = [];

          const s = srcRec || {};
          const d = dstRec || {};
          const allKeys = new Set([...Object.keys(s), ...Object.keys(d)]);

          for (const k of allKeys) {
            const sVal = s[k];
            const dVal = d[k];
            if (sVal === dVal || JSON.stringify(sVal) === JSON.stringify(dVal)) {
              matchedFields.push(k);
            } else {
              divergentFields.push({
                field: k,
                sourceValue: sVal ?? null,
                destinationValue: dVal ?? null,
                differenceReason: sVal === undefined ? 'Missing in source' : dVal === undefined ? 'Unmapped in destination' : 'Value mismatch',
              });
            }
          }

          rawResult = {
            sourceRecordId: input.sourceRecordId,
            destinationRecordId: input.destinationRecordId,
            matchedFields,
            divergentFields,
          };
          break;
        }

        case 'validate_plan_draft': {
          const draft = (input.planDraft || input.mapping || input.plan) as Record<string, any> | undefined;
          if (!draft) {
            rawResult = {
              status: 'UNAVAILABLE',
              valid: false,
              findings: [
                {
                  code: 'MISSING_PLAN_DRAFT',
                  severity: 'ERROR',
                  message: 'Plan draft payload is required for validation.',
                },
              ],
            };
            break;
          }

          const findings: Array<{ code: string; severity: string; message: string }> = [];
          const objects: any[] = Array.isArray(draft.objects) ? draft.objects : (draft.source ? [draft] : []);
          if (objects.length === 0) {
            findings.push({
              code: 'NO_MAPPED_OBJECTS',
              severity: 'ERROR',
              message: 'Plan draft contains no mapped source/destination objects.',
            });
          }

          for (const obj of objects) {
            if (!obj.source?.collection && !obj.source?.object && typeof obj.source !== 'string') {
              findings.push({
                code: 'INVALID_SOURCE_OBJECT',
                severity: 'ERROR',
                message: 'Mapped object must specify a valid source collection.',
              });
            }
            if (!obj.destination?.table && !obj.destination?.object && typeof obj.destination !== 'string') {
              findings.push({
                code: 'INVALID_DESTINATION_OBJECT',
                severity: 'ERROR',
                message: 'Mapped object must specify a valid destination table.',
              });
            }
            if (!obj.identity?.sourceKey || !obj.identity?.destinationKey) {
              findings.push({
                code: 'MISSING_IDENTITY_KEYS',
                severity: 'WARNING',
                message: 'Object mapping should specify explicit source and destination identity keys.',
              });
            }
          }

          if (findings.length === 0) {
            findings.push({
              code: 'STRUCTURAL_VALIDATION_PASSED',
              severity: 'INFO',
              message: `Plan draft structure valid across ${objects.length} mapped object(s).`,
            });
          }

          const hasErrors = findings.some((f) => f.severity === 'ERROR');
          rawResult = {
            valid: !hasErrors,
            findings,
          };
          break;
        }

        case 'create_draft_proposal': {
          const proposalId = uuidv4();
          if (this.db) {
            let actorId: string | null = context.actorId;
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let verifiedActorId: string | null = null;
            if (actorId && isUuid.test(actorId)) {
              try {
                const uRes = await this.db.query(
                  'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = $1 AND u.id = $2 LIMIT 1',
                  [context.workspaceId, actorId],
                );
                if (uRes.rows.length > 0) {
                  verifiedActorId = uRes.rows[0].id;
                }
              } catch {
                verifiedActorId = null;
              }
            }
            if (verifiedActorId) {
              try {
                await this.db.query(
                  `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
                   VALUES ($1, $2, 'USER', $3, 'CREATE_DRAFT_PROPOSAL', 'PROPOSAL', $4, $5)`,
                  [
                    context.workspaceId,
                    context.projectId || null,
                    verifiedActorId, proposalId, { input, createdAt: new Date().toISOString() },
                  ],
                );
              } catch (err: any) {
                console.warn(`[ToolCatalog] Audit event persistence notice: ${err.message}`);
              }
            }
          }
          rawResult = {
            proposalId,
            status: 'DRAFT_CREATED',
            requiresHumanApproval: true,
          };
          break;
        }

        case 'request_human_approval': {
          const approvalRequestId = uuidv4();
          if (this.db) {
            let actorId: string | null = context.actorId;
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let verifiedActorId: string | null = null;
            if (actorId && isUuid.test(actorId)) {
              try {
                const uRes = await this.db.query(
                  'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = $1 AND u.id = $2 LIMIT 1',
                  [context.workspaceId, actorId],
                );
                if (uRes.rows.length > 0) {
                  verifiedActorId = uRes.rows[0].id;
                }
              } catch {
                verifiedActorId = null;
              }
            }
            if (verifiedActorId) {
              try {
                await this.db.query(
                  `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
                   VALUES ($1, $2, 'USER', $3, 'REQUEST_HUMAN_APPROVAL', 'APPROVAL_REQUEST', $4, $5)`,
                  [
                    context.workspaceId,
                    context.projectId || null,
                    verifiedActorId, approvalRequestId, { input, createdAt: new Date().toISOString() },
                  ],
                );
              } catch (err: any) {
                console.warn(`[ToolCatalog] Audit event persistence notice: ${err.message}`);
              }
            }
          }
          rawResult = {
            approvalRequestId,
            status: 'PENDING_HUMAN_APPROVAL',
            notifiedRoles: ['ADMIN', 'OWNER'],
          };
          break;
        }

        default:
          return {
            success: false,
            error: {
              code: 'UNIMPLEMENTED_TOOL',
              message: `Tool '${toolName}' handler is not implemented.`,
            },
          };
      }

      // Sanitize output for context minimization and secret redaction
      const safeData = ToolExecutionGuard.sanitizeToolOutput(rawResult);

      return {
        success: true,
        data: safeData,
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: 'TOOL_EXECUTION_ERROR',
          message: err?.message || String(err),
        },
      };
    }
  }
}
