import { ToolExecutionRequest, ToolExecutionResponse, ToolExecutionGuard } from './tool-guard.js';
import { v4 as uuidv4 } from 'uuid';

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
              srcRec = {
                id: manifest.source_key,
                object: manifest.source_object,
                contentHash: manifest.content_hash,
                status: manifest.status,
              };
              dstRec = {
                id: manifest.destination_key,
                object: manifest.destination_object,
                contentHash: manifest.content_hash,
                status: manifest.status,
              };
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
            let actorId = context.actorId;
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!isUuid.test(actorId)) {
              try {
                const uRes = await this.db.query(
                  'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = $1 LIMIT 1',
                  [context.workspaceId],
                );
                if (uRes.rows.length > 0) {
                  actorId = uRes.rows[0].id;
                } else {
                  const fallbackUser = await this.db.query('SELECT id FROM users LIMIT 1');
                  if (fallbackUser.rows.length > 0) actorId = fallbackUser.rows[0].id;
                }
              } catch {
                try {
                  const fallbackUser = await this.db.query('SELECT id FROM users LIMIT 1');
                  if (fallbackUser.rows.length > 0) actorId = fallbackUser.rows[0].id;
                } catch {}
              }
            }
            try {
              await this.db.query(
                `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
                 VALUES ($1, $2, 'USER', $3, 'CREATE_DRAFT_PROPOSAL', 'PROPOSAL', $4, $5)`,
                [
                  context.workspaceId,
                  context.projectId || null,
                  actorId,
                  proposalId,
                  { input, createdAt: new Date().toISOString() },
                ],
              );
            } catch (err: any) {
              console.warn(`[ToolCatalog] Audit event persistence notice: ${err.message}`);
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
            let actorId = context.actorId;
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!isUuid.test(actorId)) {
              try {
                const uRes = await this.db.query(
                  'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE wm.workspace_id = $1 LIMIT 1',
                  [context.workspaceId],
                );
                if (uRes.rows.length > 0) {
                  actorId = uRes.rows[0].id;
                } else {
                  const fallbackUser = await this.db.query('SELECT id FROM users LIMIT 1');
                  if (fallbackUser.rows.length > 0) actorId = fallbackUser.rows[0].id;
                }
              } catch {
                try {
                  const fallbackUser = await this.db.query('SELECT id FROM users LIMIT 1');
                  if (fallbackUser.rows.length > 0) actorId = fallbackUser.rows[0].id;
                } catch {}
              }
            }
            try {
              await this.db.query(
                `INSERT INTO audit_events (workspace_id, project_id, actor_type, actor_id, action, resource_type, resource_id, details_json)
                 VALUES ($1, $2, 'USER', $3, 'REQUEST_HUMAN_APPROVAL', 'APPROVAL_REQUEST', $4, $5)`,
                [
                  context.workspaceId,
                  context.projectId || null,
                  actorId,
                  approvalRequestId,
                  { input, createdAt: new Date().toISOString() },
                ],
              );
            } catch (err: any) {
              console.warn(`[ToolCatalog] Audit event persistence notice: ${err.message}`);
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
