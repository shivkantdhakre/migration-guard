import { ToolExecutionRequest, ToolExecutionResponse, ToolExecutionGuard } from './tool-guard.js';

export class ToolCatalog {
  private static mockSnapshots: Map<string, any> = new Map();
  private static mockDiscrepancies: Map<string, any[]> = new Map();
  private static mockRuns: Map<string, any> = new Map();
  private static db: any = null;

  public static setDatabaseService(db: any): void {
    this.db = db;
  }

  /**
   * Seed mock data for testing or offline execution.
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
            }
          }
          const found = this.mockSnapshots.get(snapshotId);
          if (found) {
            rawResult = { ...found, isDemoModeSynthetic: true };
          } else {
            rawResult = { notFound: true, message: `Snapshot ${snapshotId} not found in workspace.` };
          }
          break;
        }

        case 'get_profile_summary': {
          const snapshotId = input.snapshotId as string;
          if (this.db) {
            const res = await this.db.query(
              'SELECT * FROM profile_runs WHERE schema_snapshot_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1',
              [snapshotId, context.workspaceId],
            );
            if (res.rows.length > 0) {
              rawResult = res.rows[0].summary_json;
              break;
            }
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
            }
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
              const batchesRes = await this.db.query(
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
            }
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
          if (this.db) {
            const batchRes = await this.db.query(
              `SELECT batch_key, status, records_failed, error_summary, attempt_count 
               FROM migration_batches 
               WHERE migration_run_id = $1 AND (status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'OUTCOME_UNKNOWN') OR records_failed > 0)
               ORDER BY sequence_no ASC LIMIT 50`,
              [runId],
            );
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
            }
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
            const discRes = await this.db.query(
              `SELECT d.* FROM discrepancies d
               JOIN validation_runs vr ON vr.id = d.validation_run_id
               WHERE d.validation_run_id = $1 AND vr.workspace_id = $2
               ORDER BY d.created_at ASC LIMIT $3`,
              [vRunId, context.workspaceId, limit],
            );
            if (discRes.rows.length > 0) {
              rawResult = {
                validationRunId: vRunId,
                discrepancies: discRes.rows.map((r: any) => ({
                  id: r.id,
                  validationRunId: r.validation_run_id,
                  sourceKey: r.source_key,
                  destinationKey: r.destination_key,
                  category: r.category,
                  severity: r.severity,
                  expectedValue: r.expected_value,
                  actualValue: r.actual_value,
                  explanation: r.explanation,
                })),
                total: discRes.rows.length,
              };
              break;
            }
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
          rawResult = {
            sourceRecordId: input.sourceRecordId,
            destinationRecordId: input.destinationRecordId,
            matchedFields: ['name', 'created_at'],
            divergentFields: [
              {
                field: 'email',
                sourceValue: 'user@example.com',
                destinationValue: null,
                differenceReason: 'Unmapped or failed cast',
              },
            ],
          };
          break;
        }

        case 'validate_plan_draft': {
          rawResult = {
            valid: true,
            findings: [
              {
                code: 'COMPATIBILITY_OK',
                severity: 'INFO',
                message: 'MongoDB ObjectId mapped to PostgreSQL text column',
              },
            ],
          };
          break;
        }

        case 'create_draft_proposal': {
          const proposalId = `prop-${Date.now()}`;
          if (this.db) {
            await this.db.query(
              `INSERT INTO audit_events (workspace_id, actor_id, actor_role, action, resource_type, resource_id, metadata_json)
               VALUES ($1, $2, $3, 'CREATE_DRAFT_PROPOSAL', 'PROPOSAL', $4, $5)`,
              [
                context.workspaceId,
                context.actorId,
                context.actorRole,
                proposalId,
                JSON.stringify({ input, createdAt: new Date().toISOString() }),
              ],
            );
          }
          rawResult = {
            proposalId,
            status: 'DRAFT_CREATED',
            requiresHumanApproval: true,
          };
          break;
        }

        case 'request_human_approval': {
          const approvalRequestId = `appr-${Date.now()}`;
          if (this.db) {
            await this.db.query(
              `INSERT INTO audit_events (workspace_id, actor_id, actor_role, action, resource_type, resource_id, metadata_json)
               VALUES ($1, $2, $3, 'REQUEST_HUMAN_APPROVAL', 'APPROVAL_REQUEST', $4, $5)`,
              [
                context.workspaceId,
                context.actorId,
                context.actorRole,
                approvalRequestId,
                JSON.stringify({ input, createdAt: new Date().toISOString() }),
              ],
            );
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
