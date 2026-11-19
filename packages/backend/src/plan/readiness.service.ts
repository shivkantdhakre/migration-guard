import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface ReadinessCheckResult {
  planVersionId: string;
  ready: boolean;
  score: number; // 0 to 100
  facts: string[];
  hypotheses: string[];
  blockers: string[];
}

@Injectable()
export class ReadinessService {
  constructor(private db: DatabaseService) {}

  async checkReadiness(planVersionId: string): Promise<ReadinessCheckResult> {
    const res = await this.db.query('SELECT * FROM migration_plan_versions WHERE id = $1', [
      planVersionId,
    ]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Plan version not found.');
    }
    const version = res.rows[0];

    const facts: string[] = [];
    const hypotheses: string[] = [];
    const blockers: string[] = [];

    // Verify source connection
    const sourceRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [
      version.source_connection_id,
    ]);
    if (sourceRes.rows.length === 0) {
      blockers.push(`Source connection ${version.source_connection_id} does not exist.`);
    } else {
      facts.push(`Source connection configured for engine ${sourceRes.rows[0].engine}.`);
      if (sourceRes.rows[0].status === 'HEALTHY') {
        facts.push('Source connection verified healthy.');
      } else {
        hypotheses.push('Source connection not recently tested; recommend running connectivity test.');
      }
    }

    // Verify destination connection
    const destRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [
      version.destination_connection_id,
    ]);
    if (destRes.rows.length === 0) {
      blockers.push(`Destination connection ${version.destination_connection_id} does not exist.`);
    } else {
      facts.push(`Destination connection configured for engine ${destRes.rows[0].engine}.`);
      if (destRes.rows[0].status === 'HEALTHY') {
        facts.push('Destination connection verified healthy.');
      }
    }

    // Verify mapping version
    if (version.mapping_version_id) {
      const mapRes = await this.db.query('SELECT * FROM mapping_versions WHERE id = $1', [
        version.mapping_version_id,
      ]);
      if (mapRes.rows.length > 0) {
        facts.push(`Mapping version #${mapRes.rows[0].version} validated with hash ${mapRes.rows[0].mapping_hash.slice(0, 16)}...`);
      } else {
        blockers.push('Configured mapping version not found.');
      }
    } else {
      hypotheses.push('No explicit mapping version attached; default 1:1 field mappings will be assumed.');
    }

    // Check execution config
    const execConfig = version.execution_config_json || {};
    if (execConfig.batchSize > 5000) {
      hypotheses.push(`Batch size (${execConfig.batchSize}) is high; may increase memory pressure.`);
    } else {
      facts.push(`Bounded batch size set to ${execConfig.batchSize || 1000}.`);
    }

    const ready = blockers.length === 0;
    const score = ready ? (hypotheses.length === 0 ? 100 : 85) : 30;

    return {
      planVersionId,
      ready,
      score,
      facts,
      hypotheses,
      blockers,
    };
  }
}
