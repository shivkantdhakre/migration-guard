import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { CredentialsService } from './credentials.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

export interface CreateConnectionDto {
  name: string;
  engine: 'MONGODB' | 'POSTGRESQL';
  connectionRole: 'SOURCE' | 'DESTINATION';
  config: Record<string, any>;
  credentials: Record<string, any>;
}

export type ConnectionProber = (
  connection: any,
  decryptedCreds: Record<string, any> | null,
) => Promise<{ reachable: boolean; engineVersion?: string; errorMessage?: string } | null>;

@Injectable()
export class ConnectionService {
  public static customProber?: ConnectionProber;

  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
    private credentialsService: CredentialsService,
  ) {}

  async listConnections(workspaceId: string, userId: string) {
    const wsId = await this.workspaceService.resolveWorkspaceId(workspaceId, userId);
    await this.workspaceService.assertWorkspaceAccess(wsId, userId, 'Viewer');
    const res = await this.db.query(
      `SELECT id, workspace_id, name, engine, connection_role, config_json, secret_ref, credential_version, status, created_at, updated_at
       FROM connections
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [wsId],
    );
    return res.rows.map((r) => this.redactConnection(r));
  }

  async createConnection(workspaceId: string, dto: CreateConnectionDto, userId: string) {
    const wsId = await this.workspaceService.resolveWorkspaceId(workspaceId, userId);
    await this.workspaceService.assertWorkspaceAccess(wsId, userId, 'Admin');

    if (!dto.name || !dto.engine || !dto.connectionRole) {
      throw new BadRequestException('Name, engine, and connectionRole are required.');
    }

    if (dto.engine !== 'MONGODB' && dto.engine !== 'POSTGRESQL') {
      throw new BadRequestException('Engine must be MONGODB or POSTGRESQL.');
    }

    // Config must not contain secrets
    const safeConfig = CryptoUtil.redactSecrets(dto.config || {});

    // Insert connection record
    const connRes = await this.db.query(
      `INSERT INTO connections (workspace_id, name, engine, connection_role, config_json, credential_version, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 1, 'UNTESTED', $6)
       RETURNING *`,
      [wsId, dto.name, dto.engine, dto.connectionRole, safeConfig, userId],
    );
    const conn = connRes.rows[0];

    // Store credentials in encrypted vault
    if (dto.credentials) {
      await this.credentialsService.storeCredentials(conn.id, 1, dto.credentials);
      await this.db.query('UPDATE connections SET secret_ref = $1 WHERE id = $2', [
        `vault:${conn.id}:v1`,
        conn.id,
      ]);
      conn.secret_ref = `vault:${conn.id}:v1`;
    }

    return this.redactConnection(conn);
  }

  async getConnection(connectionId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM connections WHERE id = $1', [connectionId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Connection not found.');
    }
    const conn = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Viewer');

    return this.redactConnection(conn);
  }

  async updateConnection(
    connectionId: string,
    updates: { name?: string; config?: Record<string, any> },
    userId: string,
  ) {
    const conn = await this.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Admin');

    const name = updates.name !== undefined ? updates.name : conn.name;
    const safeConfig = updates.config !== undefined ? CryptoUtil.redactSecrets(updates.config) : conn.config_json;

    const res = await this.db.query(
      'UPDATE connections SET name = $1, config_json = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, safeConfig, connectionId],
    );

    return this.redactConnection(res.rows[0]);
  }

  async rotateCredentials(connectionId: string, newCredentials: Record<string, any>, userId: string) {
    const conn = await this.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Admin');

    const { newVersion } = await this.credentialsService.rotateCredentials(connectionId, newCredentials);

    return {
      connectionId,
      credentialVersion: newVersion,
      message: 'Credentials rotated successfully and encrypted in vault.',
    };
  }

  async testConnection(connectionId: string, userId: string) {
    const conn = await this.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Engineer');

    let decryptedCreds: Record<string, any> | null = null;
    try {
      decryptedCreds = await this.credentialsService.getDecryptedCredentials(
        connectionId,
        conn.credential_version,
      );
    } catch (err: any) {
      console.warn(`[ConnectionService] Failed to decrypt credentials: ${err.message}`);
    }

    const isMongo = conn.engine === 'MONGODB';
    const capabilities = isMongo
      ? ['READ_STREAMS', 'SAMPLE_DOCUMENTS', 'BSON_TYPE_DISCOVERY', 'CHANGE_STREAMS_CHECK']
      : ['INSPECT_TABLES', 'READ_KEYS', 'IDEMPOTENT_UPSERT', 'BULK_WRITE', 'TRANSACTIONS'];

    const startTime = Date.now();
    let reachable = false;
    let engineVersion = conn.engine === 'MONGODB' ? 'MongoDB 7.0' : 'PostgreSQL 16';
    let errorMessage: string | null = null;

    if (ConnectionService.customProber) {
      try {
        const probeResult = await ConnectionService.customProber(conn, decryptedCreds);
        if (probeResult) {
          reachable = probeResult.reachable;
          if (probeResult.engineVersion) engineVersion = probeResult.engineVersion;
          if (probeResult.errorMessage) errorMessage = probeResult.errorMessage;
        }
      } catch (proberErr: any) {
        reachable = false;
        errorMessage = proberErr.message;
      }
    } else if (decryptedCreds) {
      try {
        if (conn.engine === 'POSTGRESQL') {
          const connStr = decryptedCreds.connectionString || decryptedCreds.uri || decryptedCreds.url;
          if (connStr) {
            const pgPool = new (require('pg').Pool)({
              connectionString: connStr,
              connectionTimeoutMillis: 2000,
            });
            try {
              const res = await pgPool.query('SELECT version();');
              reachable = true;
              engineVersion = res.rows[0]?.version || engineVersion;
            } catch (pgErr: any) {
              reachable = false;
              errorMessage = pgErr.message;
            } finally {
              await pgPool.end().catch(() => {});
            }
          } else {
            reachable = false;
            errorMessage = 'No PostgreSQL connection string or credentials provided';
          }
        } else if (conn.engine === 'MONGODB') {
          const uri = decryptedCreds.uri || decryptedCreds.connectionString || decryptedCreds.url;
          if (uri) {
            try {
              const { MongoClient } = require('mongodb');
              const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
              try {
                await client.connect();
                const pingRes = await client.db().admin().ping();
                reachable = Boolean(pingRes?.ok);
              } catch (mErr: any) {
                reachable = false;
                errorMessage = mErr.message;
              } finally {
                await client.close().catch(() => {});
              }
            } catch (initErr: any) {
              reachable = false;
              errorMessage = initErr.message;
            }
          } else {
            reachable = false;
            errorMessage = 'No MongoDB URI or connection string provided';
          }
        }
      } catch (err: any) {
        reachable = false;
        errorMessage = err.message ? err.message.replace(/:[^:@]+@/, ':***@') : 'Connection failed';
      }
    } else {
      reachable = false;
      errorMessage = 'No credentials found in vault for connection';
    }

    if (errorMessage) {
      errorMessage = errorMessage.replace(/:[^:@]+@/, ':***@');
    }

    const latencyMs = Math.max(1, Date.now() - startTime);
    const newStatus = reachable ? 'HEALTHY' : 'ERROR';

    // Update status in database
    await this.db.query('UPDATE connections SET status = $1, updated_at = NOW() WHERE id = $2', [
      newStatus,
      connectionId,
    ]);

    return {
      connectionId,
      engine: conn.engine,
      status: newStatus,
      reachable,
      latencyMs: reachable ? latencyMs : undefined,
      engineVersion: reachable ? engineVersion : undefined,
      capabilities,
      testedAt: new Date().toISOString(),
      credentialVersion: conn.credential_version,
      error: errorMessage || undefined,
    };
  }

  async deleteConnection(connectionId: string, userId: string) {
    const conn = await this.getConnection(connectionId, userId);
    await this.workspaceService.assertWorkspaceAccess(conn.workspace_id, userId, 'Admin');

    // Check if used by active migration runs
    const activeRuns = await this.db.query(
      `SELECT mr.id
       FROM migration_runs mr
       JOIN migration_plan_versions mpv ON mr.plan_version_id = mpv.id
       WHERE (mpv.source_connection_id = $1 OR mpv.destination_connection_id = $1)
         AND mr.status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
      [connectionId],
    );

    if (activeRuns.rows.length > 0) {
      throw new ConflictException(
        `Cannot delete connection ${connectionId}: currently in use by active migration runs.`,
      );
    }

    await this.db.query('DELETE FROM connections WHERE id = $1', [connectionId]);
    return { success: true, deletedConnectionId: connectionId };
  }

  private redactConnection(conn: any) {
    const copy = { ...conn };
    // Redact password or secret from config_json if any sneaked in
    copy.config_json = CryptoUtil.redactSecrets(copy.config_json);
    delete copy.password;
    delete copy.credentials;
    delete copy.connectionString;
    delete copy.secret;
    return copy;
  }
}
