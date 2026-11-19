import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

@Injectable()
export class CredentialsService {
  constructor(private db: DatabaseService) {}

  /**
   * Encrypts and stores credentials in the connection_secrets vault table
   */
  async storeCredentials(connectionId: string, version: number, credentials: any): Promise<void> {
    const serialized = JSON.stringify(credentials);
    const encrypted = CryptoUtil.encrypt(serialized);

    await this.db.query(
      `INSERT INTO connection_secrets (connection_id, version, encrypted_payload, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)`,
      [connectionId, version, encrypted.encryptedData, encrypted.iv, encrypted.authTag],
    );
  }

  /**
   * Decrypts credentials for an exact connection version from the vault
   */
  async getDecryptedCredentials(connectionId: string, version?: number): Promise<any> {
    let query = 'SELECT * FROM connection_secrets WHERE connection_id = $1';
    const params: any[] = [connectionId];

    if (version !== undefined) {
      query += ' AND version = $2';
      params.push(version);
    } else {
      query += ' ORDER BY version DESC LIMIT 1';
    }

    const res = await this.db.query(query, params);
    if (res.rows.length === 0) {
      throw new NotFoundException(`Credentials for connection ${connectionId} not found in vault.`);
    }

    const row = res.rows[0];
    const decryptedJson = CryptoUtil.decrypt({
      encryptedData: row.encrypted_payload,
      iv: row.iv,
      authTag: row.auth_tag,
    });

    return JSON.parse(decryptedJson);
  }

  /**
   * Rotates credentials, incrementing the version in connections and storing new encrypted payload
   */
  async rotateCredentials(connectionId: string, newCredentials: any): Promise<{ newVersion: number }> {
    const connRes = await this.db.query('SELECT credential_version FROM connections WHERE id = $1', [
      connectionId,
    ]);
    if (connRes.rows.length === 0) {
      throw new NotFoundException('Connection not found.');
    }

    const currentVersion = connRes.rows[0].credential_version || 1;
    const newVersion = currentVersion + 1;

    // Save in vault
    await this.storeCredentials(connectionId, newVersion, newCredentials);

    // Update connection record
    await this.db.query(
      'UPDATE connections SET credential_version = $1, secret_ref = $2, updated_at = NOW() WHERE id = $3',
      [newVersion, `vault:${connectionId}:v${newVersion}`, connectionId],
    );

    return { newVersion };
  }
}
