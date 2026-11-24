import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ConnectionService } from '../connection/connection.service';
import { CredentialsService } from '../connection/credentials.service';

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
  constructor(
    private db: DatabaseService,
    @Optional() private workspaceService?: WorkspaceService,
    @Optional() private connectionService?: ConnectionService,
    @Optional() private credentialsService?: CredentialsService,
  ) {}

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

    // 1. Verify source connection and live connectivity
    const sourceRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [
      version.source_connection_id,
    ]);
    if (sourceRes.rows.length === 0) {
      blockers.push(`Source connection ${version.source_connection_id} does not exist.`);
    } else {
      const srcConn = sourceRes.rows[0];
      facts.push(`Source connection configured for engine ${srcConn.engine}.`);
      if (srcConn.status !== 'HEALTHY') {
        blockers.push(`Source connection is not HEALTHY (current status: ${srcConn.status}). Run a connectivity test before proceeding.`);
      }

      // Live connectivity probe using configured credentials
      const srcProbeError = await this.probeConnection(srcConn, 'source');
      if (srcProbeError) {
        blockers.push(srcProbeError);
      } else if (srcConn.status === 'HEALTHY') {
        facts.push('Source connection verified healthy.');
      }
    }

    // 2. Verify destination connection and live connectivity
    const destRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [
      version.destination_connection_id,
    ]);
    if (destRes.rows.length === 0) {
      blockers.push(`Destination connection ${version.destination_connection_id} does not exist.`);
    } else {
      const dstConn = destRes.rows[0];
      facts.push(`Destination connection configured for engine ${dstConn.engine}.`);
      if (dstConn.status !== 'HEALTHY') {
        blockers.push(`Destination connection is not HEALTHY (current status: ${dstConn.status}). Run a connectivity test before proceeding.`);
      }

      // Live connectivity probe using configured credentials
      const dstProbeError = await this.probeConnection(dstConn, 'destination');
      if (dstProbeError) {
        blockers.push(dstProbeError);
      } else if (dstConn.status === 'HEALTHY') {
        facts.push('Destination connection verified healthy.');
      }
    }

    // 3. Verify mapping version and exact mapped objects
    let objects: any[] = [];
    if (version.mapping_version_id) {
      const mapRes = await this.db.query('SELECT * FROM mapping_versions WHERE id = $1', [
        version.mapping_version_id,
      ]);
      if (mapRes.rows.length > 0) {
        const hashStr = mapRes.rows[0].mapping_hash ? `${mapRes.rows[0].mapping_hash.slice(0, 16)}...` : 'N/A';
        facts.push(`Mapping version #${mapRes.rows[0].version} validated with hash ${hashStr}`);
        const mRaw = mapRes.rows[0].mapping_json;
        const parsedMap = typeof mRaw === 'string' ? JSON.parse(mRaw) : mRaw;
        objects = Array.isArray(parsedMap.objects) ? parsedMap.objects : (parsedMap.source ? [parsedMap] : []);
        if (objects.length === 0) {
          blockers.push('Approved mapping version contains no mapped objects.');
        } else {
          for (const obj of objects) {
            const rawSource = obj.source?.collection || obj.source?.object || (typeof obj.source === 'string' ? obj.source : null);
            const rawDest = obj.destination?.table || obj.destination?.object || (typeof obj.destination === 'string' ? obj.destination : null);
            if (!rawSource || !rawDest) {
              blockers.push('Mapped object missing explicit source collection/object or destination table/object name.');
            }
          }
          // Validate exact source/destination object matches with plan scope if defined
          const scope = version.scope_json || {};
          const scopeTables = scope.tables || scope.collections || [];
          if (Array.isArray(scopeTables) && scopeTables.length > 0) {
            for (const obj of objects) {
              const sName = obj.source?.collection || obj.source?.object || (typeof obj.source === 'string' ? obj.source : null);
              const dName = obj.destination?.table || obj.destination?.object || (typeof obj.destination === 'string' ? obj.destination : null);
              if (sName && dName) {
                const inScope = scopeTables.some((st: any) => {
                  if (typeof st === 'string') return st === sName || st === dName;
                  const s = st.source || st.collection || st.table;
                  const d = st.destination || st.table || st.collection;
                  return s === sName && (!d || d === dName);
                });
                if (!inScope) {
                  blockers.push(`Mapped object '${sName}' -> '${dName}' is not defined in the approved plan scope.`);
                }
              }
            }
          }
        }
      } else {
        blockers.push('Configured mapping version not found.');
      }
    } else {
      blockers.push('No mapping version configured; migration cannot proceed without an explicit approved mapping.');
    }

    // 4. Check execution config
    const execConfig = version.execution_config_json || {};
    if (execConfig.batchSize > 5000) {
      hypotheses.push(`Batch size (${execConfig.batchSize}) is high; may increase memory pressure.`);
    } else {
      facts.push(`Bounded batch size set to ${execConfig.batchSize || 1000}.`);
    }

    // 5. Source Schema Snapshot Verification (Missing & Stale Checks)
    let srcSnapRow: any = null;
    if (version.source_schema_snapshot_id) {
      const srcSnapRes = await this.db.query('SELECT * FROM schema_snapshots WHERE id = $1', [
        version.source_schema_snapshot_id,
      ]);
      if (srcSnapRes.rows.length === 0) {
        blockers.push(`Source schema snapshot '${version.source_schema_snapshot_id}' does not exist.`);
      } else {
        srcSnapRow = srcSnapRes.rows[0];
        // Check if source snapshot is stale
        if (version.source_connection_id) {
          const newerRes = await this.db.query(
            `SELECT id, schema_version FROM schema_snapshots
             WHERE connection_id = $1 AND (schema_version > $2 OR created_at > $3)
             LIMIT 1`,
            [version.source_connection_id, srcSnapRow.schema_version, srcSnapRow.created_at],
          );
          if (newerRes.rows.length > 0) {
            blockers.push(`Source schema snapshot '${version.source_schema_snapshot_id}' is stale; a newer snapshot is available.`);
          }
          if (sourceRes.rows.length > 0 && srcSnapRow.connection_version < (sourceRes.rows[0].credential_version || 1)) {
            blockers.push(`Source schema snapshot '${version.source_schema_snapshot_id}' is stale; connection credentials were updated after the snapshot was captured.`);
          }
        }
      }
    } else if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
      blockers.push('Missing source schema snapshot. In production, an approved source schema snapshot is required before migration can proceed.');
    } else if (version.source_connection_id) {
      // In non-production, check for latest available snapshot for source connection
      const latestSrc = await this.db.query(
        'SELECT * FROM schema_snapshots WHERE connection_id = $1 ORDER BY schema_version DESC, created_at DESC LIMIT 1',
        [version.source_connection_id],
      );
      if (latestSrc.rows.length > 0) {
        srcSnapRow = latestSrc.rows[0];
      } else {
        hypotheses.push('No source schema snapshot configured; schema compatibility was evaluated without source snapshot constraints.');
      }
    }

    // 6. Destination Schema Snapshot Verification (Missing & Stale Checks)
    let dstSnapRow: any = null;
    if (version.destination_schema_snapshot_id) {
      const dstSnapRes = await this.db.query('SELECT * FROM schema_snapshots WHERE id = $1', [
        version.destination_schema_snapshot_id,
      ]);
      if (dstSnapRes.rows.length === 0) {
        blockers.push(`Destination schema snapshot '${version.destination_schema_snapshot_id}' does not exist.`);
      } else {
        dstSnapRow = dstSnapRes.rows[0];
        // Check if destination snapshot is stale
        if (version.destination_connection_id) {
          const newerRes = await this.db.query(
            `SELECT id, schema_version FROM schema_snapshots
             WHERE connection_id = $1 AND (schema_version > $2 OR created_at > $3)
             LIMIT 1`,
            [version.destination_connection_id, dstSnapRow.schema_version, dstSnapRow.created_at],
          );
          if (newerRes.rows.length > 0) {
            blockers.push(`Destination schema snapshot '${version.destination_schema_snapshot_id}' is stale; a newer snapshot is available.`);
          }
          if (destRes.rows.length > 0 && dstSnapRow.connection_version < (destRes.rows[0].credential_version || 1)) {
            blockers.push(`Destination schema snapshot '${version.destination_schema_snapshot_id}' is stale; connection credentials were updated after the snapshot was captured.`);
          }
        }
      }
    } else if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
      blockers.push('Missing destination schema snapshot. In production, an approved destination schema snapshot is required before migration can proceed.');
    } else if (version.destination_connection_id) {
      // In non-production, check for latest available snapshot for destination connection
      const latestDst = await this.db.query(
        'SELECT * FROM schema_snapshots WHERE connection_id = $1 ORDER BY schema_version DESC, created_at DESC LIMIT 1',
        [version.destination_connection_id],
      );
      if (latestDst.rows.length > 0) {
        dstSnapRow = latestDst.rows[0];
      } else {
        hypotheses.push('No destination schema snapshot configured; schema compatibility was evaluated without destination snapshot constraints.');
      }
    }

    // In addition to snapshots, inspect live destination PostgreSQL database schema if available
    let liveDstEntities: any[] | null = null;
    let liveDstInspectionFailed = false;

    if (version.destination_connection_id) {
      if (!this.credentialsService && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
        blockers.push('CredentialsService is unavailable for live destination schema validation.');
      } else if (this.credentialsService) {
        try {
          const dConnRes = await this.db.query('SELECT * FROM connections WHERE id = $1', [version.destination_connection_id]);
          if (dConnRes.rows.length === 0) {
            if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
              blockers.push(`Destination connection '${version.destination_connection_id}' not found in workspace.`);
            }
          } else {
            const dConn = dConnRes.rows[0];
            if (dConn.engine !== 'POSTGRESQL') {
              if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
                blockers.push(`Destination engine '${dConn.engine}' is unsupported for live schema catalog validation.`);
              }
            } else {
              const dCreds = await this.credentialsService.getDecryptedCredentials(dConn.id, dConn.credential_version);
              const connStr = dCreds?.connectionString || dCreds?.uri || dCreds?.url;
              if (!connStr) {
                if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
                  blockers.push('Destination connection credentials are missing or unavailable in vault for live schema validation.');
                }
              } else {
                const pg = require('pg');
                const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
                try {
                  const tRes = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
                  const cRes = await pool.query(`
                    SELECT table_name, column_name, data_type, udt_name, is_nullable, character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                  `);
                  const kRes = await pool.query(`
                    SELECT tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                    WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
                    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
                  `);
                  const constraintMap = new Map<string, { tableName: string; name: string; type: string; columns: string[] }>();
                  for (const k of kRes.rows) {
                    const key = `${k.table_name}:${k.constraint_name}`;
                    let c = constraintMap.get(key);
                    if (!c) {
                      c = { tableName: k.table_name, name: k.constraint_name, type: k.constraint_type, columns: [] };
                      constraintMap.set(key, c);
                    }
                    c.columns.push(k.column_name);
                  }

                  const tableMap = new Map<string, any>();
                  for (const t of tRes.rows) {
                    tableMap.set(t.table_name, { name: t.table_name, columns: [], constraints: new Map() });
                  }
                  for (const c of cRes.rows) {
                    let tbl = tableMap.get(c.table_name);
                    if (!tbl) {
                      tbl = { name: c.table_name, columns: [], constraints: new Map() };
                      tableMap.set(c.table_name, tbl);
                    }
                    // A column is individually a primary key only if it is the ONLY column of a PRIMARY KEY constraint
                    const isPk = Array.from(constraintMap.values()).some(
                      (con) => con.tableName === c.table_name && con.type === 'PRIMARY KEY' && con.columns.length === 1 && con.columns[0] === c.column_name,
                    );
                    // A column is individually unique only if it has its own single-column UNIQUE constraint or single-column PK
                    const isUnq = isPk || Array.from(constraintMap.values()).some(
                      (con) => con.tableName === c.table_name && con.type === 'UNIQUE' && con.columns.length === 1 && con.columns[0] === c.column_name,
                    );
                    tbl.columns.push({
                      name: c.column_name,
                      type: c.udt_name || c.data_type,
                      data_type: c.data_type,
                      udt_name: c.udt_name,
                      nullable: c.is_nullable !== 'NO',
                      is_nullable: c.is_nullable,
                      isPrimaryKey: isPk,
                      isUnique: isUnq,
                      maxLength: c.character_maximum_length,
                    });
                  }
                  for (const con of constraintMap.values()) {
                    const tbl = tableMap.get(con.tableName);
                    if (tbl) {
                      tbl.constraints.set(con.name, {
                        name: con.name,
                        type: con.type,
                        columns: con.columns,
                      });
                    }
                  }
                  liveDstEntities = Array.from(tableMap.values()).map(tbl => ({
                    ...tbl,
                    constraints: Array.from(tbl.constraints.values()),
                  }));
                } finally {
                  await pool.end().catch(() => {});
                }
              }
            }
          }
        } catch (err: any) {
          liveDstInspectionFailed = true;
          console.warn(`[ReadinessService] Live destination catalog inspection notice: ${err.message}`);
          if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
            blockers.push(`Live destination schema catalog inspection failed: ${err.message}`);
          }
        }
      }
    }

    // 7. Verify Schema Compatibility & Missing Destination Tables across ALL Mapped Objects
    // Precedence: Live destination database catalog takes precedence over schema snapshots.
    const isStrict = process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false';
    if (isStrict && version.destination_connection_id) {
      if (liveDstInspectionFailed || !liveDstEntities || liveDstEntities.length === 0) {
        blockers.push('In production, live destination schema catalog inspection is mandatory when destination connection is configured. Refusing to fall back to snapshot data.');
      }
    }

    const effectiveDstEntities = (liveDstEntities && liveDstEntities.length > 0)
      ? liveDstEntities
      : (isStrict && version.destination_connection_id ? [] : (dstSnapRow ? ((dstSnapRow.snapshot_json || {}).tables || (dstSnapRow.snapshot_json || {}).collections || (dstSnapRow.snapshot_json || {}).objects || []) : []));

    if ((dstSnapRow || (liveDstEntities && liveDstEntities.length > 0)) && objects.length > 0) {
      const dstEntities = effectiveDstEntities;

      for (const obj of objects) {
        const sName = obj.source?.collection || obj.source?.object || (typeof obj.source === 'string' ? obj.source : 'customers');
        const dName = obj.destination?.table || obj.destination?.object || (typeof obj.destination === 'string' ? obj.destination : 'customers');

        const dTable = dstEntities.find((t: any) => t.name === dName);
        if (!dTable) {
          blockers.push(liveDstEntities ? `Destination table '${dName}' does not exist in live destination database.` : `Destination table '${dName}' does not exist in destination schema snapshot.`);
          continue;
        }

        const rawCols = dTable.columns || dTable.fields || [];
        const tableConstraints: any[] = dTable.constraints || [];
        const cols = rawCols.map((c: any) => {
          let isPk = !!(c.isPrimaryKey || c.is_primary_key);
          let isUnq = !!(c.isUnique || c.is_unique);
          if (tableConstraints.length > 0) {
            const inSinglePk = tableConstraints.some(
              (con: any) => (con.type === 'PRIMARY KEY' || con.type === 'PRIMARY_KEY') && Array.isArray(con.columns) && con.columns.length === 1 && con.columns[0] === (c.name || c.path),
            );
            const inSingleUnq = tableConstraints.some(
              (con: any) => con.type === 'UNIQUE' && Array.isArray(con.columns) && con.columns.length === 1 && con.columns[0] === (c.name || c.path),
            );
            const inCompositeOnly = tableConstraints.some(
              (con: any) => (con.type === 'UNIQUE' || con.type === 'PRIMARY KEY' || con.type === 'PRIMARY_KEY') && Array.isArray(con.columns) && con.columns.length > 1 && con.columns.includes(c.name || c.path),
            );
            if (inSinglePk) isPk = true;
            if (inSingleUnq || inSinglePk) isUnq = true;
            if (inCompositeOnly && !inSingleUnq && !inSinglePk) {
              isUnq = false;
              isPk = false;
            }
          }
          return {
            name: c.name || c.path,
            nullable: c.nullable !== false && c.is_nullable !== 'NO',
            isPrimaryKey: isPk,
            isUnique: isUnq || isPk,
            type: (c.type || c.dataType || c.data_type || '').toLowerCase(),
          };
        });

        // Verify required fields (non-nullable unmapped columns)
        for (const col of cols) {
          if (!col.nullable && !col.isPrimaryKey) {
            const isMapped = Array.isArray(obj.fields)
              ? obj.fields.some((f: any) => (f.destinationPath || f.destination || f.field || f.fieldPath) === col.name)
              : true;
            if (!isMapped) {
              blockers.push(`Destination table '${dName}' column '${col.name}' is non-nullable but not mapped from source '${sName}'.`);
            }
          }
        }

        // Verify composite unique constraints: every column of a composite unique/PK must be mapped or nullable
        const constraints = dTable.constraints || [];
        for (const constraint of constraints) {
          if (Array.isArray(constraint.columns) && constraint.columns.length > 1) {
            for (const colName of constraint.columns) {
              const isMapped = Array.isArray(obj.fields)
                ? obj.fields.some((f: any) => (f.destinationPath || f.destination || f.field || f.fieldPath) === colName)
                : true;
              const colDef = cols.find((c: any) => c.name === colName);
              if (!isMapped && colDef && !colDef.nullable) {
                blockers.push(`Destination table '${dName}' composite ${constraint.type} column '${colName}' is not mapped from source '${sName}'.`);
              }
            }
          }
        }

        // Verify identity constraints (Requirement 8 & 13)
        const rawDestKey = obj.identity?.destinationKey || obj.destination?.key || obj.destination?.identityKey;
        const destKey = rawDestKey || (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false' ? undefined : 'id');
        if (!rawDestKey && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
          blockers.push(`Identity key is not explicitly configured for mapped object '${sName}' -> '${dName}'.`);
        } else if (destKey) {
          const keyColumns = Array.isArray(destKey)
            ? destKey
            : (typeof destKey === 'string' && destKey.includes(','))
              ? destKey.split(',').map((k: string) => k.trim())
              : [destKey];

          if (keyColumns.length === 1) {
            const singleKey = keyColumns[0];
            const keyCol = cols.find((c: any) => c.name === singleKey);
            if (!keyCol) {
              blockers.push(`Identity key '${singleKey}' for '${dName}' does not exist in destination table schema.`);
            } else if (!keyCol.isPrimaryKey && !keyCol.isUnique) {
              blockers.push(`Identity column '${singleKey}' for destination table '${dName}' is not backed by a primary key or unique constraint.`);
            }
          } else {
            // Validate composite identity keys against the exact configured key and uniqueness constraint
            const missingCols = keyColumns.filter((k: string) => !cols.some((c: any) => c.name === k));
            if (missingCols.length > 0) {
              blockers.push(`Composite identity key column(s) '${missingCols.join(', ')}' for '${dName}' do not exist in destination table schema.`);
            } else {
              const hasMatchingConstraint = constraints.some((con: any) => {
                if (!Array.isArray(con.columns) || con.columns.length !== keyColumns.length) return false;
                const sortedConstraint = [...con.columns].sort();
                const sortedKey = [...keyColumns].sort();
                return sortedConstraint.every((col, i) => col === sortedKey[i]);
              });
              if (!hasMatchingConstraint) {
                blockers.push(`Composite identity key (${keyColumns.join(', ')}) for destination table '${dName}' is not backed by a matching composite primary key or unique constraint.`);
              }
            }
          }
        }
      }

      if (blockers.length === 0) {
        if (liveDstEntities && liveDstEntities.length > 0) {
          facts.push(`Source and destination schema compatibility verified against live destination database catalog across ${objects.length} mapped object(s).`);
        } else {
          facts.push(`Source and destination schema compatibility verified across ${objects.length} mapped object(s).`);
        }
      }
    }

    // Never return ready: true without verifying conditions (must have facts and zero blockers)
    const ready = blockers.length === 0 && facts.length > 0;
    const score = ready ? (hypotheses.length === 0 ? 100 : 85) : Math.max(0, 50 - blockers.length * 15);

    return {
      planVersionId,
      ready,
      score,
      facts,
      hypotheses,
      blockers,
    };
  }

  private async probeConnection(conn: any, role: 'source' | 'destination'): Promise<string | null> {
    let decryptedCreds: any = null;
    if (this.credentialsService) {
      try {
        decryptedCreds = await this.credentialsService.getDecryptedCredentials(
          conn.id,
          conn.credential_version,
        );
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') {
          return `Failed to retrieve credentials for ${role} connection ${conn.id}: ${err.message}`;
        }
      }
    }

    if (ConnectionService.customProber) {
      try {
        const probe = await (ConnectionService.customProber as any)(conn, decryptedCreds);
        if (probe && !probe.reachable) {
          return `Live ${role} connectivity test failed: ${probe.errorMessage || `${role} connection unreachable`}.`;
        }
      } catch (probeErr: any) {
        return `Live ${role} connectivity test failed: ${probeErr.message}.`;
      }
    } else if (decryptedCreds) {
      const connStr = decryptedCreds.connectionString || decryptedCreds.uri || decryptedCreds.url;
      if (connStr) {
        if (conn.engine === 'POSTGRESQL') {
          try {
            const pg = require('pg');
            const pool = new pg.Pool({ connectionString: connStr, connectionTimeoutMillis: 2000 });
            try {
              await pool.query('SELECT 1;');
            } finally {
              await pool.end().catch(() => {});
            }
          } catch (err: any) {
            return `Live ${role} connectivity test failed: ${err.message}.`;
          }
        } else if (conn.engine === 'MONGODB') {
          try {
            const { MongoClient } = require('mongodb');
            const client = new MongoClient(connStr, { serverSelectionTimeoutMS: 2000 });
            try {
              await client.connect();
              await client.db().admin().ping();
            } finally {
              await client.close().catch(() => {});
            }
          } catch (err: any) {
            return `Live ${role} connectivity test failed: ${err.message}.`;
          }
        }
      } else if (process.env.NODE_ENV === 'production') {
        return `Live ${role} connectivity probe failed: no valid connection URI or connectionString in credentials.`;
      }
    }
    return null;
  }
}
