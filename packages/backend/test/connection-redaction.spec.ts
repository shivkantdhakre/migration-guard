import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionService } from '../src/connection/connection.service';
import { CredentialsService } from '../src/connection/credentials.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('Connection & Secret Redaction', () => {
  let db: DatabaseService;
  let connectionService: ConnectionService;
  let credentialsService: CredentialsService;
  let workspaceService: WorkspaceService;
  let authService: AuthService;
  let user: any;
  let workspaceId: string;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    credentialsService = new CredentialsService(db);
    connectionService = new ConnectionService(db, workspaceService, credentialsService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    const email = `dbadmin_${Date.now()}_${Math.random().toString(36).slice(2)}@corp.com`;
    user = await authService.register(email, 'DB Admin', 'SecretPassword!');
    workspaceId = user.workspace.id;
  });

  it('should store credentials in AES-256-GCM vault and never expose them in API responses', async () => {
    const rawCredentials = {
      username: 'migration_user',
      password: 'SuperSecretDatabasePassword99$',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----SECRET-----END RSA PRIVATE KEY-----',
    };

    const conn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'Production Mongo Source',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: {
          host: 'mongo.internal.net',
          port: 27017,
          database: 'ecommerce',
        },
        credentials: rawCredentials,
      },
      user.user.id,
    );

    // 1. Check returned connection object
    expect(conn.id).toBeDefined();
    expect(conn.name).toBe('Production Mongo Source');
    expect(conn.secret_ref).toBe(`vault:${conn.id}:v1`);
    expect(conn.credential_version).toBe(1);

    // CRITICAL: Credentials must NOT exist in returned object
    expect((conn as any).password).toBeUndefined();
    expect((conn as any).credentials).toBeUndefined();
    expect((conn as any).privateKey).toBeUndefined();

    // 2. Querying connection directly must not expose secrets
    const fetched = await connectionService.getConnection(conn.id, user.user.id);
    expect((fetched as any).password).toBeUndefined();
    expect((fetched as any).credentials).toBeUndefined();

    // 3. Vault verification: raw credentials are encrypted in connection_secrets
    const secretsRows = await db.query(
      'SELECT * FROM connection_secrets WHERE connection_id = $1 AND version = 1',
      [conn.id],
    );
    expect(secretsRows.rows.length).toBe(1);
    const vaultRow = secretsRows.rows[0];
    expect(vaultRow.encrypted_payload).not.toContain('SuperSecretDatabasePassword99$');
    expect(vaultRow.iv).toBeDefined();
    expect(vaultRow.auth_tag).toBeDefined();

    // 4. Decryption by authorized vault service retrieves accurate credentials
    const decrypted = await credentialsService.getDecryptedCredentials(conn.id, 1);
    expect(decrypted.username).toBe('migration_user');
    expect(decrypted.password).toBe('SuperSecretDatabasePassword99$');
  });

  it('should test connectivity and return sanitized outcome without secrets', async () => {
    const conn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'Target Postgres',
        engine: 'POSTGRESQL',
        connectionRole: 'DESTINATION',
        config: { host: 'pg.internal.net', port: 5432, database: 'analytics' },
        credentials: { username: 'pg_writer', password: 'pg_secret_pass' },
      },
      user.user.id,
    );

    const testResult = await connectionService.testConnection(conn.id, user.user.id);

    expect(testResult.status).toBe('HEALTHY');
    expect(testResult.reachable).toBe(true);
    expect(testResult.engine).toBe('POSTGRESQL');
    expect(testResult.capabilities).toContain('BULK_WRITE');
    expect(testResult.capabilities).toContain('IDEMPOTENT_UPSERT');

    // Sanitized: no host, username, or password
    expect((testResult as any).password).toBeUndefined();
    expect((testResult as any).host).toBeUndefined();
  });

  it('should rotate credentials and increment credential version in vault', async () => {
    const conn = await connectionService.createConnection(
      workspaceId,
      {
        name: 'Source MongoDB',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { host: 'mongo.internal.net', port: 27017, database: 'prod' },
        credentials: { username: 'old_user', password: 'old_password_1' },
      },
      user.user.id,
    );

    expect(conn.credential_version).toBe(1);

    // Rotate credentials
    const rotateRes = await connectionService.rotateCredentials(
      conn.id,
      { username: 'new_rotated_user', password: 'new_rotated_password_2' },
      user.user.id,
    );

    expect(rotateRes.credentialVersion).toBe(2);

    // Verify v1 and v2 both exist in vault (active runs retain historical versions)
    const v1 = await credentialsService.getDecryptedCredentials(conn.id, 1);
    expect(v1.password).toBe('old_password_1');

    const v2 = await credentialsService.getDecryptedCredentials(conn.id, 2);
    expect(v2.password).toBe('new_rotated_password_2');

    // Connection record points to v2
    const updatedConn = await connectionService.getConnection(conn.id, user.user.id);
    expect(updatedConn.credential_version).toBe(2);
    expect(updatedConn.secret_ref).toBe(`vault:${conn.id}:v2`);
  });
});
