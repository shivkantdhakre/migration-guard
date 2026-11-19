import { ToolExecutionRequest, ToolExecutionResponse, ToolExecutionGuard } from './tool-guard.js';

export class ToolCatalog {
  private static mockSnapshots: Map<string, any> = new Map();
  private static mockDiscrepancies: Map<string, any[]> = new Map();
  private static mockRuns: Map<string, any> = new Map();

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

    const { toolName, input } = request;

    try {
      let rawResult: any;

      switch (toolName) {
        case 'get_schema_snapshot': {
          const snapshotId = input.snapshotId as string;
          const found = this.mockSnapshots.get(snapshotId) || {
            id: snapshotId,
            engine: snapshotId.includes('pg') ? 'POSTGRESQL' : 'MONGODB',
            createdAt: new Date().toISOString(),
            objects: [
              {
                name: 'customers',
                type: 'collection',
                fields: [
                  { path: '_id', type: 'ObjectId', nullable: false },
                  { path: 'name', type: 'string', nullable: false },
                  { path: 'email', type: 'string', nullable: true },
                  { path: 'createdAt', type: 'Date', nullable: false },
                  { path: 'address', type: 'object', nullable: true },
                  { path: 'orders', type: 'array', nullable: true },
                ],
              },
            ],
          };
          rawResult = found;
          break;
        }

        case 'get_profile_summary': {
          const snapshotId = input.snapshotId as string;
          rawResult = {
            snapshotId,
            sampleSize: 1000,
            profiles: [
              {
                object: 'customers',
                field: 'email',
                nullCount: 15,
                distinctValues: 985,
                typeDistribution: { string: 985, null: 15 },
              },
              {
                object: 'customers',
                field: 'createdAt',
                nullCount: 0,
                observedFormats: ['ISO_8601', 'EPOCH_MS'],
              },
            ],
          };
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
          rawResult = {
            versionId,
            version: 1,
            rules: [
              { sourcePath: '_id', destinationPath: 'source_id', transform: { op: 'PRESERVE_SOURCE_ID' } },
              { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
              { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
            ],
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
          const found = this.mockRuns.get(runId) || {
            runId,
            status: 'FAILED',
            totalRecords: 10000,
            processedRecords: 8500,
            failedRecords: 1500,
            activeBatches: 0,
            failedBatches: 3,
            throughput: 420.5,
          };
          rawResult = found;
          break;
        }

        case 'get_batch_errors': {
          const runId = input.runId as string;
          rawResult = {
            runId,
            batchErrors: [
              {
                batchId: 'batch-0042',
                errorCode: 'DATA_CONVERSION_ERROR',
                errorMessage: 'Invalid ISO timestamp string in column created_at',
                affectedKeys: ['cust_101', 'cust_102'],
                retryCount: 3,
                isRetryable: false,
              },
            ],
          };
          break;
        }

        case 'get_discrepancy_evidence': {
          const vRunId = input.validationRunId as string;
          const list = this.mockDiscrepancies.get(vRunId) || [
            {
              id: 'disc-001',
              validationRunId: vRunId,
              sourceKey: 'cust_01',
              destinationKey: 'cust_01',
              category: 'ATTACHMENT_MISSING',
              severity: 'CRITICAL',
              expectedValue: 'avatar_sha256_hash',
              actualValue: null,
              explanation: 'Attachment file not found in destination S3 bucket',
            },
            {
              id: 'disc-002',
              validationRunId: vRunId,
              sourceKey: 'cust_02',
              destinationKey: 'cust_02',
              category: 'ATTACHMENT_MISSING',
              severity: 'CRITICAL',
              expectedValue: 'doc_sha256_hash',
              actualValue: null,
              explanation: 'Attachment file not found in destination S3 bucket',
            },
            {
              id: 'disc-003',
              validationRunId: vRunId,
              sourceKey: 'cust_03',
              destinationKey: 'cust_03',
              category: 'DUPLICATE_RECORD',
              severity: 'HIGH',
              expectedValue: 'Unique email user@example.com',
              actualValue: '2 occurrences in destination table',
              explanation: 'Multiple destination rows have matching unique email',
            },
          ];
          rawResult = {
            validationRunId: vRunId,
            discrepancies: list.slice(0, (input.limit as number) || 50),
            total: list.length,
          };
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
          rawResult = {
            proposalId,
            status: 'DRAFT_CREATED',
            requiresHumanApproval: true,
          };
          break;
        }

        case 'request_human_approval': {
          rawResult = {
            approvalRequestId: `appr-${Date.now()}`,
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
