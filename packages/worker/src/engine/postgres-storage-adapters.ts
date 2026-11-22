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
import {
  CheckpointAdvanceParams,
  CheckpointStorageAdapter,
  mergeCheckpointUpdate,
} from './checkpoint.js';
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
        id, migration_run_id, batch_key, sequence_no, status,
        records_read, records_written, records_skipped, records_failed,
        attempt_count, source_cursor_start, source_cursor_end, error_summary, started_at, completed_at
      ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT (migration_run_id, batch_key) DO UPDATE SET
        status = EXCLUDED.status,
        records_read = EXCLUDED.records_read,
        records_written = EXCLUDED.records_written,
        records_skipped = EXCLUDED.records_skipped,
        records_failed = EXCLUDED.records_failed,
        attempt_count = EXCLUDED.attempt_count,
        source_cursor_start = EXCLUDED.source_cursor_start,
        source_cursor_end = EXCLUDED.source_cursor_end,
        error_summary = EXCLUDED.error_summary,
        completed_at = EXCLUDED.completed_at
      RETURNING id;
    `;

    const cursorStart = batch.sourceCursorStart || {};
    const meta = {
      sourceObject: batch.sourceObject,
      destinationObject: batch.destinationObject,
      subStage: batch.subStage,
      maxAttempts: batch.maxAttempts,
    };
    const enrichedCursorStart = typeof cursorStart === 'object' && cursorStart !== null
      ? { ...cursorStart, _meta: meta }
      : { value: cursorStart, _meta: meta };

    const res = await this.pool.query(query, [
      batch.id || null,
      batch.migrationRunId,
      batch.batchKey,
      batch.sequenceNo,
      batch.status,
      batch.recordsRead,
      batch.recordsWritten,
      batch.recordsSkipped,
      batch.recordsFailed,
      batch.attemptCount || 0,
      JSON.stringify(enrichedCursorStart),
      batch.sourceCursorEnd ? JSON.stringify(batch.sourceCursorEnd) : null,
      batch.errorSummary ? JSON.stringify(batch.errorSummary) : null,
      batch.startedAt ? new Date(batch.startedAt) : null,
      batch.completedAt ? new Date(batch.completedAt) : null,
    ]);

    if (res?.rows?.length > 0 && res.rows[0].id) {
      batch.id = res.rows[0].id;
    }
  }

  async getBatch(migrationRunId: string, batchKey: string): Promise<MigrationBatch | null> {
    const res = await this.pool.query(
      `SELECT * FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
      [migrationRunId, batchKey],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    const meta = r.source_cursor_start?._meta || r.error_summary?._meta;
    const inferredSource = r.batch_key ? r.batch_key.split('_')[0] : 'default';
    return {
      id: r.id,
      migrationRunId: r.migration_run_id,
      batchKey: r.batch_key,
      sequenceNo: Number(r.sequence_no),
      status: r.status as BatchStatus,
      sourceObject: r.source_object || meta?.sourceObject || inferredSource,
      destinationObject: r.destination_object || meta?.destinationObject || meta?.sourceObject || inferredSource,
      maxAttempts: Number(r.max_attempts || meta?.maxAttempts || 3),
      subStage: (r.sub_stage || meta?.subStage || undefined) as BatchSubStage | undefined,
      recordsRead: Number(r.records_read || 0),
      recordsWritten: Number(r.records_written || 0),
      recordsSkipped: Number(r.records_skipped || 0),
      recordsFailed: Number(r.records_failed || 0),
      attemptCount: Number(r.attempt_count || 0),
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
    return res.rows.map((r) => {
      const meta = r.source_cursor_start?._meta || r.error_summary?._meta;
      const inferredSource = r.batch_key ? r.batch_key.split('_')[0] : 'default';
      return {
        id: r.id,
        migrationRunId: r.migration_run_id,
        batchKey: r.batch_key,
        sequenceNo: Number(r.sequence_no),
        status: r.status as BatchStatus,
        sourceObject: r.source_object || meta?.sourceObject || inferredSource,
        destinationObject: r.destination_object || meta?.destinationObject || meta?.sourceObject || inferredSource,
        maxAttempts: Number(r.max_attempts || meta?.maxAttempts || 3),
        subStage: (r.sub_stage || meta?.subStage || undefined) as BatchSubStage | undefined,
        recordsRead: Number(r.records_read || 0),
        recordsWritten: Number(r.records_written || 0),
        recordsSkipped: Number(r.records_skipped || 0),
        recordsFailed: Number(r.records_failed || 0),
        attemptCount: Number(r.attempt_count || 0),
        sourceCursorStart: r.source_cursor_start,
        sourceCursorEnd: r.source_cursor_end,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
      };
    });
  }

  async saveRecordManifests(manifests: RecordManifest[]): Promise<void> {
    if (manifests.length === 0) return;

    // Enforce non-null destination coordinates and batch key
    for (const m of manifests) {
      if (!m.batchKey || m.batchKey.trim() === '') {
        throw new Error(`Record manifest for source key '${m.sourceKey}' is missing batchKey.`);
      }
      if (!m.destinationObject || m.destinationObject.trim() === '') {
        throw new Error(`Record manifest for source key '${m.sourceKey}' is missing destinationObject.`);
      }
      if (!m.destinationKey || m.destinationKey.trim() === '') {
        throw new Error(`Record manifest for source key '${m.sourceKey}' is missing destinationKey.`);
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Pre-resolve batch IDs for manifests by (migrationRunId, batchKey)
      const batchMap = new Map<string, { id: string; migrationRunId: string; batchKey: string }>();
      const batchKeysToLookup = Array.from(
        new Set(manifests.map((m) => m.batchKey)),
      );
      if (batchKeysToLookup.length > 0) {
        const batchRes = await client.query(
          `SELECT id, migration_run_id, batch_key FROM migration_batches WHERE migration_run_id = $1 AND batch_key = ANY($2::text[])`,
          [manifests[0].migrationRunId, batchKeysToLookup],
        );
        for (const r of batchRes.rows) {
          batchMap.set(r.batch_key, {
            id: r.id,
            migrationRunId: r.migration_run_id,
            batchKey: r.batch_key,
          });
        }
      }

      // Enforce exact manifest-to-batch relationship and reject invalid references
      for (const m of manifests) {
        const resolvedBatch = batchMap.get(m.batchKey);
        if (!resolvedBatch) {
          throw new Error(
            `Batch '${m.batchKey}' does not exist for migration run '${m.migrationRunId}'. Missing batch resolution is rejected.`,
          );
        }
        if (m.migrationBatchId && m.migrationBatchId !== resolvedBatch.id) {
          throw new Error(
            `Mismatched batch relationship: manifest specifies migrationBatchId '${m.migrationBatchId}', but batch '${m.batchKey}' resolves to '${resolvedBatch.id}'.`,
          );
        }
      }

      const query = `
        INSERT INTO record_manifests (
          id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
          destination_object, destination_key, content_hash, status, error_details, created_at
        ) VALUES (
          COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
        )
        ON CONFLICT (migration_run_id, source_object, source_key) DO UPDATE SET
          migration_batch_id = EXCLUDED.migration_batch_id,
          batch_key = EXCLUDED.batch_key,
          destination_object = EXCLUDED.destination_object,
          destination_key = EXCLUDED.destination_key,
          content_hash = EXCLUDED.content_hash,
          status = EXCLUDED.status,
          error_details = EXCLUDED.error_details,
          created_at = NOW();
      `;

      for (const m of manifests) {
        const resolvedBatch = batchMap.get(m.batchKey)!;
        await client.query(query, [
          m.id || null,
          m.migrationRunId,
          resolvedBatch.id,
          m.batchKey,
          m.sourceObject,
          m.sourceKey,
          m.destinationObject,
          m.destinationKey,
          m.contentHash || null,
          m.status || 'WRITTEN',
          m.error || null,
        ]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRecordManifests(migrationRunId: string, batchKey?: string): Promise<RecordManifest[]> {
    let query = `SELECT * FROM record_manifests WHERE migration_run_id = $1`;
    const params: any[] = [migrationRunId];

    if (batchKey) {
      query += ` AND batch_key = $2`;
      params.push(batchKey);
    }

    query += ` ORDER BY created_at ASC`;
    const res = await this.pool.query(query, params);

    return res.rows.map((r) => {
      // Reject or explicitly surface incomplete legacy records without fallback substitution
      if (!r.destination_object || !r.destination_key) {
        throw new Error(
          `[RecordManifest Integrity] Incomplete record manifest detected (id=${r.id}): destination_object or destination_key is null. Source fallbacks are strictly prohibited.`,
        );
      }

      return {
        id: r.id,
        migrationRunId: r.migration_run_id,
        migrationBatchId: r.migration_batch_id || undefined,
        batchKey: r.batch_key || '',
        sourceObject: r.source_object,
        sourceKey: r.source_key,
        destinationObject: r.destination_object,
        destinationKey: r.destination_key,
        contentHash: r.content_hash || undefined,
        status: (r.status as 'WRITTEN' | 'SKIPPED' | 'FAILED') || 'WRITTEN',
        error: r.error_details || undefined,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      };
    });
  }

  // --- CheckpointStorageAdapter ---

  /**
   * P0.1: Atomically read, merge, advance, and persist the checkpoint within a single
   * PostgreSQL transaction holding a SELECT ... FOR UPDATE row-level lock on migration_runs.
   * This completely prevents the lost-update race condition when concurrent workers
   * commit batches for the same migration run.
   */
  async advanceCheckpoint(params: CheckpointAdvanceParams): Promise<MigrationCheckpoint> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock the row and fetch the latest committed boundary state
      const lockRes = await client.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1 FOR UPDATE`,
        [params.migrationRunId],
      );

      if (lockRes.rows.length === 0) {
        throw new Error(`Migration run not found: ${params.migrationRunId}`);
      }

      // 2. Parse current checkpoint for this sourceObject
      const boundary = lockRes.rows[0].source_boundary_json;
      const parsedBoundary = typeof boundary === 'string' ? JSON.parse(boundary) : (boundary || {});
      let current: MigrationCheckpoint | null = null;
      if (parsedBoundary && typeof parsedBoundary === 'object') {
        if (parsedBoundary[params.sourceObject]) {
          current = parsedBoundary[params.sourceObject];
        } else if (parsedBoundary.sourceObject === params.sourceObject) {
          current = parsedBoundary;
        }
      }

      // 3. Compute the updated checkpoint using pure merge logic
      const updated = mergeCheckpointUpdate(current, params);

      // 4. Atomically persist the updated checkpoint
      await client.query(
        `UPDATE migration_runs 
         SET source_boundary_json = jsonb_set(
           COALESCE(source_boundary_json, '{}'::jsonb),
           ARRAY[$1],
           $2::jsonb
         ), 
         updated_at = NOW() 
         WHERE id = $3`,
        [params.sourceObject, JSON.stringify(updated), params.migrationRunId],
      );

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Save checkpoint directly within a row-locked transaction.
   */
  async saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row for the duration of this update
      await client.query(
        `SELECT id FROM migration_runs WHERE id = $1 FOR UPDATE`,
        [checkpoint.migrationRunId],
      );

      // Now apply the checkpoint update atomically
      await client.query(
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

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
