import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface MigrationProgress {
  runId: string;
  status: string;
  totalRecordsEstimated: number;
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  recordsPerSecond: number;
  percentageComplete: number;
  startedAt?: string;
  completedAt?: string;
}

@Injectable()
export class ProgressService {
  constructor(private db: DatabaseService) {}

  async getProgress(runId: string): Promise<MigrationProgress> {
    const runRes = await this.db.query('SELECT * FROM migration_runs WHERE id = $1', [runId]);
    if (runRes.rows.length === 0) {
      throw new NotFoundException('Migration run not found.');
    }
    const run = runRes.rows[0];

    // Aggregate from migration_batches
    const batchAggRes = await this.db.query(
      `SELECT
         COUNT(*) as total_batches,
         COUNT(*) FILTER (WHERE status = 'COMMITTED') as committed_batches,
         COALESCE(SUM(records_read), 0) as total_read,
         COALESCE(SUM(records_written), 0) as total_written,
         COALESCE(SUM(records_skipped), 0) as total_skipped,
         COALESCE(SUM(records_failed), 0) as total_failed
       FROM migration_batches
       WHERE migration_run_id = $1`,
      [runId],
    );

    const agg = batchAggRes.rows[0] || {};
    const totalBatches = parseInt(agg.total_batches || '0', 10);
    const committedBatches = parseInt(agg.committed_batches || '0', 10);
    const recordsRead = parseInt(agg.total_read || '0', 10);
    const recordsWritten = parseInt(agg.total_written || '0', 10);
    const recordsSkipped = parseInt(agg.total_skipped || '0', 10);
    const recordsFailed = parseInt(agg.total_failed || '0', 10);

    const processed = recordsWritten + recordsSkipped + recordsFailed;
    const isTerminalCompleted =
      run.status === 'COMPLETED' || run.status === 'MIGRATED' || run.status === 'VALIDATED';
    const estimatedTotal = Math.max(processed, recordsRead, 0);
    const percentageComplete = isTerminalCompleted
      ? 100
      : totalBatches > 0
      ? Math.min(99, parseFloat(((committedBatches / totalBatches) * 100).toFixed(2)))
      : 0;

    // Calculate throughput
    let recordsPerSecond = 0;
    if (run.started_at) {
      const startTime = new Date(run.started_at).getTime();
      const endTime = run.completed_at ? new Date(run.completed_at).getTime() : Date.now();
      const durationSec = Math.max(1, (endTime - startTime) / 1000);
      recordsPerSecond = Math.round(processed / durationSec);
    }

    return {
      runId,
      status: run.status,
      totalRecordsEstimated: estimatedTotal,
      recordsRead,
      recordsWritten,
      recordsSkipped,
      recordsFailed,
      recordsPerSecond,
      percentageComplete,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    };
  }
}
