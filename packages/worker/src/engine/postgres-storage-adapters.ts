import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  MigrationBatch,
  RecordManifest,
  BatchStatus,
  BatchSubStage,
  MigrationCheckpoint,
  IdMappingRecord,
} from '../types.js';
import { BatchManifestStorageAdapter } from './batch-manifest.js';
import { CheckpointStorageAdapter } from './checkpoint.js';
import { IdMappingStorageAdapter } from './id-tracker.js';

export class PostgresStorageAdapters
  implements BatchManifestStorageAdapter, CheckpointStorageAdapter, IdMappingStorageAdapter
{
  private pool: pg.Pool;

  constructor(poolOrConnectionString: pg.Pool | string) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = new pg.Pool({
        connectionString: poolOrConnectionString,
        connectionTimeoutMillis: 10000,
      });
    } else {
      this.pool = poolOrConnectionString;
    }
  }

  // --- BatchManifestStorageAdapter ---

  async saveBatch(batch: MigrationBatch): Promise<void> {
    const query = `
      INSERT INTO migration_batches (
        migration_run_id, batch_key, sequence_no, status,
        records_read, records_written, records_skipped, records_failed,
        source_cursor_start, source_cursor_end, error_summary, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (migration_run_id, batch_key) DO UPDATE SET
        status = EXCLUDED.status,
        records_read = EXCLUDED.records_read,
        records_written = EXCLUDED.records_written,
        records_skipped = EXCLUDED.records_skipped,
        records_failed = EXCLUDED.records_failed,
        source_cursor_end = EXCLUDED.source_cursor_end,
        error_summary = EXCLUDED.error_summary,
        completed_at = EXCLUDED.completed_at;
    `;

    await this.pool.query(query, [
      batch.migrationRunId,
      batch.batchKey,
      batch.sequenceNo,
      batch.status,
      batch.recordsRead,
      batch.recordsWritten,
      batch.recordsSkipped,
      batch.recordsFailed,
      batch.sourceCursorStart ? JSON.stringify(batch.sourceCursorStart) : null,
      batch.sourceCursorEnd ? JSON.stringify(batch.sourceCursorEnd) : null,
      batch.errorSummary ? JSON.stringify(batch.errorSummary) : null,
      batch.startedAt ? new Date(batch.startedAt) : null,
      batch.completedAt ? new Date(batch.completedAt) : null,
    ]);
  }

  async getBatch(migrationRunId: string, batchKey: string): Promise<MigrationBatch | null> {
    const res = await this.pool.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
      [migrationRunId, batchKey],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      migrationRunId: r.migration_run_id,
      batchKey: r.batch_key,
      sequenceNo: Number(r.sequence_no),
      status: r.status as BatchStatus,
      sourceObject: r.source_object || 'customers',
      destinationObject: r.destination_object || 'customers',
      maxAttempts: r.max_attempts || 3,
      recordsRead: Number(r.records_read || 0),
      recordsWritten: Number(r.records_written || 0),
      recordsSkipped: Number(r.records_skipped || 0),
      recordsFailed: Number(r.records_failed || 0),
      attemptCount: r.attempt_count || 0,
      sourceCursorStart: r.source_cursor_start,
      sourceCursorEnd: r.source_cursor_end,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
    };
  }

  async listBatches(migrationRunId: string): Promise<MigrationBatch[]> {
    const res = await this.pool.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 ORDER BY sequence_no ASC`,
      [migrationRunId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      migrationRunId: r.migration_run_id,
      batchKey: r.batch_key,
      sequenceNo: Number(r.sequence_no),
      status: r.status as BatchStatus,
      sourceObject: r.source_object || 'customers',
      destinationObject: r.destination_object || 'customers',
      maxAttempts: r.max_attempts || 3,
      recordsRead: Number(r.records_read || 0),
      recordsWritten: Number(r.records_written || 0),
      recordsSkipped: Number(r.records_skipped || 0),
      recordsFailed: Number(r.records_failed || 0),
      attemptCount: r.attempt_count || 0,
      sourceCursorStart: r.source_cursor_start,
      sourceCursorEnd: r.source_cursor_end,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
    }));
  }

  async saveRecordManifests(manifests: RecordManifest[]): Promise<void> {
    if (manifests.length === 0) return;

    for (const m of manifests) {
      await this.pool.query(
        `INSERT INTO record_manifests (
           migration_run_id, source_object, source_key, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          m.migrationRunId,
          m.sourceObject,
          m.sourceKey,
          m.destinationKey,
          m.contentHash,
          m.status || 'COMMITTED',
        ],
      );
    }
  }

  async listRecordManifests(migrationRunId: string, _batchKey?: string): Promise<RecordManifest[]> {
    const res = await this.pool.query(
      `SELECT * FROM record_manifests WHERE migration_run_id = $1 ORDER BY created_at ASC`,
      [migrationRunId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      migrationRunId: r.migration_run_id,
      batchKey: '',
      sourceObject: r.source_object,
      sourceKey: r.source_key,
      destinationObject: r.destination_key ? r.source_object : r.source_object,
      destinationKey: r.destination_key || r.source_key,
      contentHash: r.content_hash,
      status: r.status as any,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    }));
  }

  // --- CheckpointStorageAdapter ---

  async saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
    await this.pool.query(
      `UPDATE migration_runs 
       SET source_boundary_json = jsonb_set(
         COALESCE(source_boundary_json, '{}'::jsonb),
         ARRAY[$1],
         $2::jsonb
       ), 
       updated_at = NOW() 
       WHERE id = $3`,
      [checkpoint.sourceObject, JSON.stringify(checkpoint), checkpoint.migrationRunId],
    );
  }

  async getCheckpoint(
    migrationRunId: string,
    sourceObject: string,
  ): Promise<MigrationCheckpoint | null> {
    const res = await this.pool.query(
      `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
      [migrationRunId],
    );
    if (res.rows.length === 0 || !res.rows[0].source_boundary_json) return null;
    const boundary = res.rows[0].source_boundary_json;
    const parsed = typeof boundary === 'string' ? JSON.parse(boundary) : boundary;
    if (parsed && typeof parsed === 'object') {
      if (parsed[sourceObject]) return parsed[sourceObject];
      if (parsed.sourceObject === sourceObject) return parsed;
    }
    return null;
  }

  async deleteCheckpoint(migrationRunId: string, sourceObject: string): Promise<void> {
    await this.pool.query(
      `UPDATE migration_runs 
       SET source_boundary_json = COALESCE(source_boundary_json, '{}'::jsonb) - $1
       WHERE id = $2`,
      [sourceObject, migrationRunId],
    );
  }

  // --- IdMappingStorageAdapter ---

  async saveMappings(mappings: IdMappingRecord[]): Promise<void> {
    for (const m of mappings) {
      await this.pool.query(
        `INSERT INTO id_mappings (
           migration_run_id, source_object, source_key, destination_object, destination_key
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (migration_run_id, source_object, source_key)
         DO UPDATE SET destination_key = EXCLUDED.destination_key`,
        [m.migrationRunId, m.sourceObject, m.sourceKey, m.destinationObject, m.destinationKey],
      );
    }
  }

  async findBySourceKey(
    migrationRunId: string,
    sourceObject: string,
    sourceKey: string,
  ): Promise<IdMappingRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM id_mappings 
       WHERE migration_run_id = $1 AND source_object = $2 AND source_key = $3`,
      [migrationRunId, sourceObject, sourceKey],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id || randomUUID(),
      migrationRunId: r.migration_run_id,
      sourceObject: r.source_object,
      sourceKey: r.source_key,
      destinationObject: r.destination_object,
      destinationKey: r.destination_key,
      createdAt: r.created_at,
    };
  }

  async findByDestinationKey(
    migrationRunId: string,
    destinationObject: string,
    destinationKey: string,
  ): Promise<IdMappingRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM id_mappings 
       WHERE migration_run_id = $1 AND destination_object = $2 AND destination_key = $3`,
      [migrationRunId, destinationObject, destinationKey],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id || randomUUID(),
      migrationRunId: r.migration_run_id,
      sourceObject: r.source_object,
      sourceKey: r.source_key,
      destinationObject: r.destination_object,
      destinationKey: r.destination_key,
      createdAt: r.created_at,
    };
  }

  async listByRun(migrationRunId: string, sourceObject?: string): Promise<IdMappingRecord[]> {
    let query = `SELECT * FROM id_mappings WHERE migration_run_id = $1`;
    const params: any[] = [migrationRunId];
    if (sourceObject) {
      query += ` AND source_object = $2`;
      params.push(sourceObject);
    }
    const res = await this.pool.query(query, params);
    return res.rows.map((r) => ({
      id: r.id || randomUUID(),
      migrationRunId: r.migration_run_id,
      sourceObject: r.source_object,
      sourceKey: r.source_key,
      destinationObject: r.destination_object,
      destinationKey: r.destination_key,
      createdAt: r.created_at,
    }));
  }

  async deleteByRun(migrationRunId: string): Promise<void> {
    await this.pool.query(`DELETE FROM id_mappings WHERE migration_run_id = $1`, [migrationRunId]);
  }
}
