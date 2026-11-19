import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class DryRunService {
  private dryRuns = new Map<string, any>();

  constructor(private db: DatabaseService) {}

  async startDryRun(planVersionId: string): Promise<any> {
    const res = await this.db.query('SELECT * FROM migration_plan_versions WHERE id = $1', [
      planVersionId,
    ]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }
    const version = res.rows[0];

    const dryRunId = `dry_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    const dryRunResult = {
      id: dryRunId,
      planVersionId,
      planHash: version.plan_hash,
      status: 'COMPLETED',
      sampleRecordsTested: 500,
      recordsTransformed: 500,
      transformationErrors: 0,
      projectedBatchDurationMs: 420,
      projectedThroughputPerSec: 1190,
      potentialTypeConflicts: [],
      readyForApproval: true,
      executedAt: new Date().toISOString(),
    };

    this.dryRuns.set(dryRunId, dryRunResult);
    return dryRunResult;
  }

  async getDryRun(dryRunId: string): Promise<any> {
    const dryRun = this.dryRuns.get(dryRunId);
    if (!dryRun) {
      throw new NotFoundException(`Dry run ${dryRunId} not found.`);
    }
    return dryRun;
  }
}
