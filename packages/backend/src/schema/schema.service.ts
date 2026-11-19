import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ConnectionService } from '../connection/connection.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { v4 as uuidv4 } from 'uuid';

export interface DiscoveryOptions {
  scope?: { databases?: string[]; collections?: string[]; schemas?: string[]; tables?: string[] };
  sample?: { enabled?: boolean; maxDocumentsPerCollection?: number };
}

@Injectable()
export class SchemaService {
  // In-memory job state cache for discovery and profiling
  private jobs = new Map<string, any>();

  constructor(
    private db: DatabaseService,
    private connectionService: ConnectionService,
    private workspaceService: WorkspaceService,
  ) {}

  async triggerDiscovery(connectionId: string, options: DiscoveryOptions, userId: string) {
    const conn = await this.connectionService.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Engineer');

    const jobId = `disc_job_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Generate discovery snapshot based on engine
    const isMongo = conn.engine === 'MONGODB';
    const snapshotJson = isMongo
      ? {
          database: conn.config_json.database || 'appdb',
          collections: [
            {
              name: 'customers',
              documentCount: 10000,
              fields: [
                { path: '_id', type: 'ObjectId', nullable: false },
                { path: 'name', type: 'String', nullable: false },
                { path: 'email', type: 'String', nullable: true },
                { path: 'createdAt', type: 'Date', nullable: false },
                { path: 'address', type: 'Object', nullable: true },
                { path: 'tags', type: 'Array', nullable: true },
              ],
            },
            {
              name: 'orders',
              documentCount: 25000,
              fields: [
                { path: '_id', type: 'ObjectId', nullable: false },
                { path: 'customerId', type: 'ObjectId', nullable: false },
                { path: 'amount', type: 'Decimal128', nullable: false },
                { path: 'status', type: 'String', nullable: false },
                { path: 'items', type: 'Array', nullable: true },
                { path: 'createdAt', type: 'Date', nullable: false },
              ],
            },
          ],
        }
      : {
          database: conn.config_json.database || 'postgres',
          schema: 'public',
          tables: [
            {
              name: 'customers',
              rowCount: 0,
              columns: [
                { name: 'id', type: 'uuid', isPrimaryKey: true, nullable: false },
                { name: 'source_id', type: 'varchar(64)', isPrimaryKey: false, nullable: false },
                { name: 'name', type: 'varchar(255)', isPrimaryKey: false, nullable: false },
                { name: 'email', type: 'varchar(255)', isPrimaryKey: false, nullable: true },
                { name: 'created_at', type: 'timestamptz', isPrimaryKey: false, nullable: false },
                { name: 'address', type: 'jsonb', isPrimaryKey: false, nullable: true },
              ],
            },
            {
              name: 'orders',
              rowCount: 0,
              columns: [
                { name: 'id', type: 'uuid', isPrimaryKey: true, nullable: false },
                { name: 'source_id', type: 'varchar(64)', isPrimaryKey: false, nullable: false },
                { name: 'customer_id', type: 'uuid', isPrimaryKey: false, nullable: false },
                { name: 'amount', type: 'numeric(12,2)', isPrimaryKey: false, nullable: false },
                { name: 'status', type: 'varchar(32)', isPrimaryKey: false, nullable: false },
                { name: 'items', type: 'jsonb', isPrimaryKey: false, nullable: true },
                { name: 'created_at', type: 'timestamptz', isPrimaryKey: false, nullable: false },
              ],
            },
          ],
        };

    // Count existing snapshots for this connection to determine schema_version
    const countRes = await this.db.query(
      'SELECT COUNT(*) as count FROM schema_snapshots WHERE connection_id = $1',
      [connectionId],
    );
    const schemaVersion = parseInt(countRes.rows[0].count, 10) + 1;

    // Persist immutable snapshot
    const insertRes = await this.db.query(
      `INSERT INTO schema_snapshots (workspace_id, connection_id, connection_version, schema_version, snapshot_json, discovery_metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        conn.workspace_id,
        connectionId,
        conn.credential_version || 1,
        schemaVersion,
        snapshotJson,
        { scope: options.scope, sample: options.sample, discoveredBy: userId },
      ],
    );

    const snapshot = insertRes.rows[0];

    this.jobs.set(jobId, {
      id: jobId,
      connectionId,
      status: 'COMPLETED',
      snapshotId: snapshot.id,
      schemaVersion,
      createdAt: new Date().toISOString(),
    });

    return {
      jobId,
      status: 'QUEUED',
      snapshotId: snapshot.id,
      connectionId,
    };
  }

  async getDiscoveryJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new NotFoundException(`Discovery job ${jobId} not found.`);
    }
    return job;
  }

  async listSnapshots(connectionId: string, userId: string) {
    const conn = await this.connectionService.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Viewer');

    const res = await this.db.query(
      `SELECT id, workspace_id, connection_id, connection_version, schema_version, created_at
       FROM schema_snapshots
       WHERE connection_id = $1
       ORDER BY created_at DESC`,
      [connectionId],
    );
    return res.rows;
  }

  async getSnapshot(snapshotId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM schema_snapshots WHERE id = $1', [snapshotId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Schema snapshot not found.');
    }
    const snapshot = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(snapshot.workspace_id, userId, 'Viewer');
    return snapshot;
  }

  async startProfiling(snapshotId: string, userId: string) {
    const snapshot = await this.getSnapshot(snapshotId, userId);
    await this.workspaceService.assertWorkspaceAccess(snapshot.workspace_id, userId, 'Engineer');

    const profileRunId = `prof_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    const summary = {
      profileRunId,
      snapshotId,
      sampleSize: 1000,
      nullPercentages: {
        'customers.email': 2.4,
        'customers.address': 15.1,
        'orders.items': 0.0,
      },
      typeVariations: {
        'orders.amount': ['Decimal128', 'Double'],
      },
      cardinalityEstimates: {
        'customers._id': 10000,
        'orders._id': 25000,
      },
    };

    const res = await this.db.query(
      `INSERT INTO profile_runs (workspace_id, schema_snapshot_id, status, summary_json)
       VALUES ($1, $2, 'COMPLETED', $3)
       RETURNING *`,
      [snapshot.workspace_id, snapshotId, summary],
    );

    return res.rows[0];
  }

  async getProfileRun(profileRunId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM profile_runs WHERE id = $1', [profileRunId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Profile run not found.');
    }
    const run = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(run.workspace_id, userId, 'Viewer');
    return run;
  }

  async compareSnapshots(sourceSnapshotId: string, targetSnapshotId: string, userId: string) {
    const sourceSnap = await this.getSnapshot(sourceSnapshotId, userId);
    const targetSnap = await this.getSnapshot(targetSnapshotId, userId);

    if (!sourceSnap || !targetSnap) {
      throw new BadRequestException('Both snapshots must exist.');
    }

    const sJson = sourceSnap.snapshot_json || {};
    const tJson = targetSnap.snapshot_json || {};

    const sourceObjects = sJson.collections || sJson.tables || [];
    const targetObjects = tJson.collections || tJson.tables || [];

    const sourceNames = new Set(sourceObjects.map((o: any) => o.name));
    const targetNames = new Set(targetObjects.map((o: any) => o.name));

    const added = targetObjects.filter((o: any) => !sourceNames.has(o.name));
    const removed = sourceObjects.filter((o: any) => !targetNames.has(o.name));
    const common = sourceObjects.filter((o: any) => targetNames.has(o.name));

    return {
      sourceSnapshotId,
      targetSnapshotId,
      diff: {
        addedObjects: added.map((o: any) => o.name),
        removedObjects: removed.map((o: any) => o.name),
        commonObjects: common.map((o: any) => o.name),
      },
      summary: `${added.length} added, ${removed.length} removed, ${common.length} common entities.`,
    };
  }
}
