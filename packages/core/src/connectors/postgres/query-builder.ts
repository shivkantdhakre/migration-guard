import { WriteMode } from '../../types/index.js';

/**
 * Escapes and quotes an SQL identifier (table, schema, column) to prevent SQL injection
 */
export function quoteIdent(ident: string): string {
  if (!ident || typeof ident !== 'string') {
    throw new Error(`Invalid identifier: ${ident}`);
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Parses and quotes a qualified table name (e.g. "public.users" or "users")
 */
export function quoteTableName(tableName: string, defaultSchema = 'public'): string {
  if (tableName.includes('.')) {
    const parts = tableName.split('.');
    return `${quoteIdent(parts[0])}.${quoteIdent(parts[1])}`;
  }
  return `${quoteIdent(defaultSchema)}.${quoteIdent(tableName)}`;
}

export interface ParameterizedQuery {
  text: string;
  values: unknown[];
}

/**
 * Builds parameterized INSERT / UPSERT statement for a batch of records
 */
export function buildBatchInsertQuery(params: {
  tableName: string;
  defaultSchema?: string;
  records: Array<Record<string, unknown>>;
  mode: WriteMode;
  conflictColumns?: string[];
  updateColumns?: string[];
}): ParameterizedQuery {
  const { tableName, defaultSchema = 'public', records, mode, conflictColumns = [], updateColumns } = params;

  if (records.length === 0) {
    throw new Error('Cannot build insert query for empty records batch');
  }

  // Determine uniform column list from first record or union of all keys
  const colSet = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      colSet.add(key);
    }
  }
  const columns = Array.from(colSet);
  const quotedCols = columns.map((c) => quoteIdent(c)).join(', ');
  const quotedTable = quoteTableName(tableName, defaultSchema);

  const values: unknown[] = [];
  const valueRows: string[] = [];

  let paramIdx = 1;
  for (const rec of records) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      let val = rec[col];
      // If object or array and not buffer/date, stringify to JSON
      if (
        val !== null &&
        val !== undefined &&
        typeof val === 'object' &&
        !(val instanceof Date) &&
        !(val instanceof Uint8Array)
      ) {
        val = JSON.stringify(val);
      }
      values.push(val === undefined ? null : val);
      rowPlaceholders.push(`$${paramIdx++}`);
    }
    valueRows.push(`(${rowPlaceholders.join(', ')})`);
  }

  let sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES \n  ${valueRows.join(',\n  ')}`;

  if (mode === 'SKIP_EXISTING') {
    if (conflictColumns.length > 0) {
      const quotedConflicts = conflictColumns.map((c) => quoteIdent(c)).join(', ');
      sql += `\nON CONFLICT (${quotedConflicts}) DO NOTHING`;
    } else {
      sql += `\nON CONFLICT DO NOTHING`;
    }
  } else if (mode === 'UPSERT') {
    if (conflictColumns.length === 0) {
      throw new Error('UPSERT mode requires at least one conflictColumn');
    }
    const quotedConflicts = conflictColumns.map((c) => quoteIdent(c)).join(', ');

    // Determine update columns
    const colsToUpdate = updateColumns && updateColumns.length > 0
      ? updateColumns
      : columns.filter((c) => !conflictColumns.includes(c));

    if (colsToUpdate.length > 0) {
      const updateClauses = colsToUpdate.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
      sql += `\nON CONFLICT (${quotedConflicts}) DO UPDATE SET\n  ${updateClauses.join(',\n  ')}`;
    } else {
      sql += `\nON CONFLICT (${quotedConflicts}) DO NOTHING`;
    }
  }

  return {
    text: sql,
    values,
  };
}
