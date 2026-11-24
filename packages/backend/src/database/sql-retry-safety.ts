import * as libpgQuery from 'libpg-query';

export interface QueryableLike {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface SqlRelationRef {
  schemaname?: string;
  relname: string;
  alias?: string;
}

export interface SqlColumnRef {
  qualifier?: string;
  column: string;
}

export interface SqlFunctionRef {
  schema?: string;
  name: string;
}

export interface SqlAstAnalysis {
  relations: SqlRelationRef[];
  columns: SqlColumnRef[];
  usesGlobalWildcard: boolean;
  wildcardQualifiers: Set<string>;
  functions: SqlFunctionRef[];
  operators: Set<string>;
  castTargets: Set<string>;
}

export interface SemanticRetrySafetyResult {
  safe: boolean;
  reason?: string;
}

const SAFE_AST_OPERATORS = new Set([
  '=',
  '<>',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  '~~',
  '!~~',
  '~~*',
  '!~~*',
]);

const ALLOWED_A_EXPR_KINDS = new Set([
  'AEXPR_OP',
  'AEXPR_OP_ANY',
  'AEXPR_OP_ALL',
  'AEXPR_IN',
  'AEXPR_LIKE',
  'AEXPR_ILIKE',
  'AEXPR_DISTINCT',
  'AEXPR_NOT_DISTINCT',
  'AEXPR_BETWEEN',
  'AEXPR_NOT_BETWEEN',
  'AEXPR_NULLIF',
]);

const ALLOWED_SQL_VALUE_FUNCTION_OPS = new Set([
  'SVFOP_CURRENT_DATE',
  'SVFOP_CURRENT_TIME',
  'SVFOP_CURRENT_TIME_N',
  'SVFOP_CURRENT_TIMESTAMP',
  'SVFOP_CURRENT_TIMESTAMP_N',
  'SVFOP_LOCALTIME',
  'SVFOP_LOCALTIME_N',
  'SVFOP_LOCALTIMESTAMP',
  'SVFOP_LOCALTIMESTAMP_N',
]);

export const SAFE_PURE_SQL_FUNCTIONS = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'GREATEST',
  'LEAST',
  'LOWER',
  'UPPER',
  'TRIM',
  'BTRIM',
  'LTRIM',
  'RTRIM',
  'LENGTH',
  'CHAR_LENGTH',
  'CHARACTER_LENGTH',
  'SUBSTRING',
  'SUBSTR',
  'CONCAT',
  'CONCAT_WS',
  'SPLIT_PART',
  'REPLACE',
  'NOW',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'VERSION',
  'CURRENT_DATABASE',
  'CURRENT_SCHEMA',
  'CAST',
  'EXTRACT',
  'DATE_TRUNC',
  'TO_CHAR',
  'TO_TIMESTAMP',
  'JSON_BUILD_OBJECT',
  'JSONB_BUILD_OBJECT',
  'JSON_AGG',
  'JSONB_AGG',
  'JSON_TYPEOF',
  'JSONB_TYPEOF',
  'ARRAY_AGG',
  'ROW_NUMBER',
  'RANK',
  'DENSE_RANK',
  'ABS',
  'ROUND',
  'FLOOR',
  'CEIL',
  'CEILING',
]);

export const SAFE_BUILTIN_PG_CATALOG_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'int',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'float4',
  'float8',
  'real',
  'double',
  'text',
  'varchar',
  'character',
  'bpchar',
  'char',
  'bool',
  'boolean',
  'uuid',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'json',
  'jsonb',
  'bytea',
  // pg_catalog system view scalar types when querying information_schema/pg_catalog safely
  'name',
  'oid',
  'xid',
  'cid',
  'tid',
  '_int2',
  '_int4',
  '_int8',
  '_numeric',
  '_float4',
  '_float8',
  '_text',
  '_varchar',
  '_bpchar',
  '_bool',
  '_uuid',
  '_timestamp',
  '_timestamptz',
  '_jsonb',
  // information_schema built-in sql domains resolved cleanly over pg_catalog base types
  'sql_identifier',
  'character_data',
  'cardinal_number',
  'yes_or_no',
  'time_stamp',
]);

const SYSTEM_READONLY_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

let parserInitialized = false;
let parserInitPromise: Promise<void> | null = null;

export async function ensurePgParserLoaded(): Promise<void> {
  if (parserInitialized) return;
  if (!parserInitPromise) {
    parserInitPromise = Promise.resolve(libpgQuery.loadModule())
      .then(() => {
        parserInitialized = true;
      })
      .catch((err) => {
        parserInitPromise = null;
        throw err;
      });
  }
  await parserInitPromise;
}

export function isPgParserLoaded(): boolean {
  return parserInitialized;
}

function unwrapSingleStringName(nameParts: any[] | undefined): { schema?: string; name: string } | null {
  if (!Array.isArray(nameParts) || nameParts.length === 0 || nameParts.length > 2) {
    return null;
  }
  const strings: string[] = [];
  for (const part of nameParts) {
    const sval = part?.String?.sval;
    if (typeof sval !== 'string' || !sval) return null;
    strings.push(sval);
  }
  if (strings.length === 1) {
    return { name: strings[0] };
  }
  return { schema: strings[0], name: strings[1] };
}

function inspectSelectAstNode(node: any, acc: SqlAstAnalysis): boolean {
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.every((item) => inspectSelectAstNode(item, acc));
  }

  const keys = Object.keys(node);
  if (keys.length === 0) return true;

  // Handle wrapped AST nodes (e.g. { SelectStmt: {...} }, { ResTarget: {...} })
  for (const key of keys) {
    const val = node[key];
    switch (key) {
      case 'SelectStmt': {
        if (!val || typeof val !== 'object') return false;
        if (val.withClause || val.intoClause || val.lockingClause || val.valuesLists || val.windowClause) {
          return false;
        }
        const op = val.op;
        if (op && op !== 'SETOP_NONE' && op !== 'SETOP_UNION' && op !== 'SETOP_INTERSECT' && op !== 'SETOP_EXCEPT') {
          return false;
        }
        return (
          inspectSelectAstNode(val.distinctClause, acc) &&
          inspectSelectAstNode(val.targetList, acc) &&
          inspectSelectAstNode(val.fromClause, acc) &&
          inspectSelectAstNode(val.whereClause, acc) &&
          inspectSelectAstNode(val.groupClause, acc) &&
          inspectSelectAstNode(val.havingClause, acc) &&
          inspectSelectAstNode(val.sortClause, acc) &&
          inspectSelectAstNode(val.limitCount, acc) &&
          inspectSelectAstNode(val.limitOffset, acc) &&
          inspectSelectAstNode(val.larg, acc) &&
          inspectSelectAstNode(val.rarg, acc)
        );
      }
      case 'ResTarget':
        return inspectSelectAstNode(val?.val, acc);
      case 'RangeVar': {
        if (!val || typeof val.relname !== 'string' || !val.relname) return false;
        acc.relations.push({
          schemaname: typeof val.schemaname === 'string' && val.schemaname ? val.schemaname : undefined,
          relname: val.relname,
          alias: typeof val.alias?.aliasname === 'string' ? val.alias.aliasname : undefined,
        });
        return true;
      }
      case 'JoinExpr':
        return (
          inspectSelectAstNode(val?.larg, acc) &&
          inspectSelectAstNode(val?.rarg, acc) &&
          inspectSelectAstNode(val?.quals, acc)
        );
      case 'RangeSubselect':
        if (!val || val.lateral) return false;
        return inspectSelectAstNode(val.subquery, acc);
      case 'SubLink': {
        const st = val?.subLinkType;
        if (
          st !== 'EXISTS_SUBLINK' &&
          st !== 'ALL_SUBLINK' &&
          st !== 'ANY_SUBLINK' &&
          st !== 'EXPR_SUBLINK'
        ) {
          return false;
        }
        return (
          inspectSelectAstNode(val.testexpr, acc) &&
          inspectSelectAstNode(val.subselect, acc)
        );
      }
      case 'ColumnRef': {
        const fields = val?.fields;
        if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3) return false;
        if (fields.length === 1) {
          if (fields[0]?.A_Star !== undefined) {
            acc.usesGlobalWildcard = true;
            return true;
          }
          const col = fields[0]?.String?.sval;
          if (typeof col !== 'string') return false;
          acc.columns.push({ column: col });
          return true;
        }
        if (fields.length === 2) {
          const first = fields[0]?.String?.sval;
          if (typeof first !== 'string') return false;
          if (fields[1]?.A_Star !== undefined) {
            acc.wildcardQualifiers.add(first);
            return true;
          }
          const second = fields[1]?.String?.sval;
          if (typeof second !== 'string') return false;
          acc.columns.push({ qualifier: first, column: second });
          return true;
        }
        const s0 = fields[0]?.String?.sval;
        const s1 = fields[1]?.String?.sval;
        if (typeof s0 !== 'string' || typeof s1 !== 'string') return false;
        if (fields[2]?.A_Star !== undefined) {
          acc.wildcardQualifiers.add(`${s0}.${s1}`);
          acc.wildcardQualifiers.add(s1);
          return true;
        }
        const s2 = fields[2]?.String?.sval;
        if (typeof s2 !== 'string') return false;
        acc.columns.push({ qualifier: `${s0}.${s1}`, column: s2 });
        return true;
      }
      case 'FuncCall': {
        const fnRef = unwrapSingleStringName(val?.funcname);
        if (!fnRef) return false;
        if (fnRef.schema && fnRef.schema.toLowerCase() !== 'pg_catalog') {
          return false;
        }
        const upperName = fnRef.name.toUpperCase();
        if (!SAFE_PURE_SQL_FUNCTIONS.has(upperName)) {
          return false;
        }
        acc.functions.push({
          schema: fnRef.schema ? fnRef.schema.toLowerCase() : undefined,
          name: fnRef.name.toLowerCase(),
        });
        return (
          inspectSelectAstNode(val?.args, acc) &&
          inspectSelectAstNode(val?.agg_order, acc) &&
          inspectSelectAstNode(val?.agg_filter, acc) &&
          inspectSelectAstNode(val?.over ? { WindowDef: val.over } : undefined, acc)
        );
      }
      case 'WindowDef':
        return (
          inspectSelectAstNode(val?.partitionClause, acc) &&
          inspectSelectAstNode(val?.orderClause, acc)
        );
      case 'A_Expr': {
        if (!val || !ALLOWED_A_EXPR_KINDS.has(val.kind)) return false;
        if (val.name !== undefined) {
          const opRef = unwrapSingleStringName(val.name);
          // Reject any schema-qualified OPERATOR(schema.op) syntax or non-allowlisted operator
          if (!opRef || opRef.schema || !SAFE_AST_OPERATORS.has(opRef.name)) {
            return false;
          }
          acc.operators.add(opRef.name);
        }
        return inspectSelectAstNode(val.lexpr, acc) && inspectSelectAstNode(val.rexpr, acc);
      }
      case 'TypeCast': {
        const typeRef = unwrapSingleStringName(val?.typeName?.names);
        if (!typeRef) return false;
        if (typeRef.schema && typeRef.schema.toLowerCase() !== 'pg_catalog') {
          return false;
        }
        const normalizedType = typeRef.name.toLowerCase();
        if (
          normalizedType.startsWith('reg') ||
          !SAFE_BUILTIN_PG_CATALOG_TYPES.has(normalizedType)
        ) {
          return false;
        }
        acc.castTargets.add(normalizedType);
        return (
          inspectSelectAstNode(val?.arg, acc) &&
          inspectSelectAstNode(val?.typeName?.typmods, acc)
        );
      }
      case 'SQLValueFunction':
        return Boolean(val?.op && ALLOWED_SQL_VALUE_FUNCTION_OPS.has(val.op));
      case 'BoolExpr':
        return inspectSelectAstNode(val?.args, acc);
      case 'NullTest':
      case 'BooleanTest':
        return inspectSelectAstNode(val?.arg, acc);
      case 'CaseExpr':
        return (
          inspectSelectAstNode(val?.arg, acc) &&
          inspectSelectAstNode(val?.args, acc) &&
          inspectSelectAstNode(val?.defresult, acc)
        );
      case 'CaseWhen':
        return inspectSelectAstNode(val?.expr, acc) && inspectSelectAstNode(val?.result, acc);
      case 'CoalesceExpr':
      case 'MinMaxExpr':
        return inspectSelectAstNode(val?.args, acc);
      case 'SortBy':
        return inspectSelectAstNode(val?.node, acc);
      case 'List':
        return inspectSelectAstNode(val?.items, acc);
      case 'A_ArrayExpr':
        return inspectSelectAstNode(val?.elements, acc);
      case 'A_Const':
      case 'ParamRef':
      case 'A_Star':
      case 'Integer':
      case 'Float':
      case 'String':
      case 'Boolean':
      case 'Null':
        return true;
      default:
        // Fail closed on any unrecognized PostgreSQL AST construct (e.g. ExplainStmt, InsertStmt, RangeFunction, SubscriptingRef)
        return false;
    }
  }

  return true;
}

export function analyzeReadQueryAstSync(sql: string): SqlAstAnalysis | null {
  if (!sql || typeof sql !== 'string' || !sql.trim()) return null;
  if (!parserInitialized) return null;

  let parsed: any;
  try {
    parsed = libpgQuery.parseSync(sql);
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.stmts) || parsed.stmts.length !== 1) {
    return null;
  }

  const rootStmt = parsed.stmts[0]?.stmt;
  if (!rootStmt || !rootStmt.SelectStmt) {
    return null;
  }

  const analysis: SqlAstAnalysis = {
    relations: [],
    columns: [],
    usesGlobalWildcard: false,
    wildcardQualifiers: new Set(),
    functions: [],
    operators: new Set(),
    castTargets: new Set(),
  };

  if (!inspectSelectAstNode({ SelectStmt: rootStmt.SelectStmt }, analysis)) {
    return null;
  }

  return analysis;
}

export async function analyzeReadQueryAst(sql: string): Promise<SqlAstAnalysis | null> {
  await ensurePgParserLoaded();
  return analyzeReadQueryAstSync(sql);
}

/**
 * Inspects PostgreSQL system catalogs (`current_schemas`, `pg_class`, `pg_attribute`, `pg_type`,
 * `pg_rewrite`, `pg_proc`, `pg_operator`, `pg_cast`) to verify semantic resolution safety before retry.
 * Only reads pg_catalog metadata; never evaluates user query expressions.
 */
export async function verifyQuerySemanticRetrySafety(
  queryable: QueryableLike,
  sql: string,
): Promise<SemanticRetrySafetyResult> {
  try {
    return await runSemanticCatalogVerification(queryable, sql);
  } catch (err: any) {
    return {
      safe: false,
      reason: `Semantic catalog inspection failed (${err?.message || 'unknown error'}).`,
    };
  }
}

async function runSemanticCatalogVerification(
  queryable: QueryableLike,
  sql: string,
): Promise<SemanticRetrySafetyResult> {
  const ast = await analyzeReadQueryAst(sql);
  if (!ast) {
    return { safe: false, reason: 'Query rejected by PostgreSQL AST retry-safety allowlist.' };
  }

  // 1. Verify active search_path starts with pg_catalog
  let searchSchemasWithImplicit: string[] = [];
  let explicitSchemas: string[] = [];
  try {
    const schemaRes = await queryable.query<{
      search_schemas: string[];
      explicit_schemas: string[];
    }>('SELECT current_schemas(true) AS search_schemas, current_schemas(false) AS explicit_schemas');
    const row = schemaRes?.rows?.[0];
    if (!row || !Array.isArray(row.search_schemas) || row.search_schemas.length === 0) {
      return { safe: false, reason: 'Semantic catalog inspection unavailable (current_schemas returned empty).' };
    }
    searchSchemasWithImplicit = row.search_schemas;
    explicitSchemas = Array.isArray(row.explicit_schemas) ? row.explicit_schemas : [];
  } catch (err: any) {
    return {
      safe: false,
      reason: `Semantic catalog inspection failed (${err?.message || 'unknown error'}).`,
    };
  }

  if (searchSchemasWithImplicit[0] !== 'pg_catalog') {
    return {
      safe: false,
      reason: `Untrusted search_path: expected pg_catalog first, got [${searchSchemasWithImplicit.join(', ')}].`,
    };
  }

  const schemasToInspect = new Set<string>(explicitSchemas);
  for (const rel of ast.relations) {
    if (rel.schemaname) schemasToInspect.add(rel.schemaname);
  }

  // 2. Inspect referenced relations and resolved column types
  interface ResolvedTable {
    oid: number;
    schema: string;
    relname: string;
    alias?: string;
    columns: Map<string, { typname: string; typnamespace: string; typtype: string }>;
  }
  const resolvedTables: ResolvedTable[] = [];

  for (const rel of ast.relations) {
    if (rel.schemaname && SYSTEM_READONLY_SCHEMAS.has(rel.schemaname.toLowerCase())) {
      resolvedTables.push({
        oid: 0,
        schema: rel.schemaname.toLowerCase(),
        relname: rel.relname,
        alias: rel.alias,
        columns: new Map(),
      });
      continue;
    }

    const clsQuery = rel.schemaname
      ? `SELECT c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
         LIMIT 1`
      : `SELECT c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1) AND c.relname = $2
         ORDER BY array_position($1, n.nspname) ASC
         LIMIT 1`;
    const clsParams = rel.schemaname ? [rel.schemaname, rel.relname] : [searchSchemasWithImplicit, rel.relname];
    const clsRes = await queryable.query<any>(clsQuery, clsParams);
    const cls = clsRes?.rows?.[0];

    if (!cls) {
      return { safe: false, reason: `Relation '${rel.relname}' could not be resolved in pg_catalog.` };
    }

    const resolvedSchema = String(cls.nspname);
    schemasToInspect.add(resolvedSchema);

    if (!SYSTEM_READONLY_SCHEMAS.has(resolvedSchema)) {
      if (cls.relkind !== 'r' && cls.relkind !== 'p') {
        return {
          safe: false,
          reason: `Relation '${resolvedSchema}.${cls.relname}' has relkind '${cls.relkind}'; views/foreign tables are not retry-eligible.`,
        };
      }
      if (cls.relrowsecurity === true) {
        return {
          safe: false,
          reason: `Relation '${resolvedSchema}.${cls.relname}' enables RLS policies which may invoke functions.`,
        };
      }

      const ruleRes = await queryable.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM pg_catalog.pg_rewrite WHERE ev_class = $1`,
        [cls.oid],
      );
      if (Number(ruleRes?.rows?.[0]?.cnt || 0) > 0) {
        return {
          safe: false,
          reason: `Relation '${resolvedSchema}.${cls.relname}' has rewrite rules.`,
        };
      }

      const attrRes = await queryable.query<{
        attname: string;
        typname: string;
        typnamespace: string;
        typtype: string;
      }>(
        `SELECT a.attname, t.typname, tn.nspname AS typnamespace, t.typtype
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
        [cls.oid],
      );

      const colMap = new Map<string, { typname: string; typnamespace: string; typtype: string }>();
      for (const r of attrRes?.rows || []) {
        colMap.set(r.attname, {
          typname: r.typname,
          typnamespace: r.typnamespace,
          typtype: r.typtype,
        });
      }
      resolvedTables.push({
        oid: Number(cls.oid),
        schema: resolvedSchema,
        relname: String(cls.relname),
        alias: rel.alias,
        columns: colMap,
      });
    } else {
      resolvedTables.push({
        oid: Number(cls.oid),
        schema: resolvedSchema,
        relname: String(cls.relname),
        alias: rel.alias,
        columns: new Map(),
      });
    }
  }

  const nonSystemTables = resolvedTables.filter((t) => !SYSTEM_READONLY_SCHEMAS.has(t.schema));
  const checkColumnTypeSafe = (
    tableLabel: string,
    colName: string,
    info: { typname: string; typnamespace: string; typtype: string },
  ): SemanticRetrySafetyResult | null => {
    if (
      info.typnamespace !== 'pg_catalog' ||
      info.typtype !== 'b' ||
      info.typname.startsWith('reg') ||
      !SAFE_BUILTIN_PG_CATALOG_TYPES.has(info.typname)
    ) {
      return {
        safe: false,
        reason: `Column '${tableLabel}.${colName}' has non-builtin type '${info.typnamespace}.${info.typname}' (${info.typtype}).`,
      };
    }
    return null;
  };

  if (ast.usesGlobalWildcard) {
    for (const tbl of nonSystemTables) {
      if (tbl.columns.size === 0) {
        return { safe: false, reason: `No inspectable columns returned for '${tbl.schema}.${tbl.relname}'.` };
      }
      for (const [colName, info] of tbl.columns.entries()) {
        const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colName, info);
        if (failure) return failure;
      }
    }
  } else {
    for (const qualifier of ast.wildcardQualifiers) {
      const matched = nonSystemTables.filter(
        (t) => t.alias === qualifier || t.relname === qualifier || `${t.schema}.${t.relname}` === qualifier,
      );
      for (const tbl of matched) {
        for (const [colName, info] of tbl.columns.entries()) {
          const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colName, info);
          if (failure) return failure;
        }
      }
    }

    for (const colRef of ast.columns) {
      if (colRef.qualifier) {
        const matched = resolvedTables.filter(
          (t) =>
            t.alias === colRef.qualifier ||
            t.relname === colRef.qualifier ||
            `${t.schema}.${t.relname}` === colRef.qualifier,
        );
        if (matched.length === 0 && nonSystemTables.length > 0) {
          for (const tbl of nonSystemTables) {
            for (const [colName, info] of tbl.columns.entries()) {
              const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colName, info);
              if (failure) return failure;
            }
          }
          continue;
        }
        for (const tbl of matched) {
          if (SYSTEM_READONLY_SCHEMAS.has(tbl.schema)) continue;
          const info = tbl.columns.get(colRef.column);
          if (!info) {
            return {
              safe: false,
              reason: `Column '${colRef.qualifier}.${colRef.column}' could not be verified against pg_attribute.`,
            };
          }
          const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colRef.column, info);
          if (failure) return failure;
        }
      } else if (nonSystemTables.length > 0) {
        let foundInAnyNonSystem = false;
        for (const tbl of nonSystemTables) {
          const info = tbl.columns.get(colRef.column);
          if (info) {
            foundInAnyNonSystem = true;
            const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colRef.column, info);
            if (failure) return failure;
          }
        }
        const onlySystemTables = resolvedTables.length > 0 && nonSystemTables.length === 0;
        if (!foundInAnyNonSystem && !onlySystemTables) {
          // Wait: column might come from subquery alias or SELECT alias in ORDER BY; ensure at least all columns
          // of involved user tables don't contain custom types when unqualified column names appear in complex queries.
          for (const tbl of nonSystemTables) {
            for (const [colName, info] of tbl.columns.entries()) {
              const failure = checkColumnTypeSafe(`${tbl.schema}.${tbl.relname}`, colName, info);
              if (failure) return failure;
            }
          }
        }
      }
    }
  }

  const nonCatalogSchemas = Array.from(schemasToInspect).filter((s) => !SYSTEM_READONLY_SCHEMAS.has(s));

  // 3. Check pg_proc for non-pg_catalog function overloads and volatility
  if (ast.functions.length > 0) {
    const fnNames = Array.from(new Set(ast.functions.map((f) => f.name.toLowerCase())));
    const procRes = await queryable.query<{
      proname: string;
      nspname: string;
      provolatile: string;
    }>(
      `SELECT p.proname, n.nspname, p.provolatile
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE LOWER(p.proname) = ANY($1)
         AND (n.nspname = 'pg_catalog' OR n.nspname = ANY($2))`,
      [fnNames, nonCatalogSchemas],
    );

    const hasUnqualifiedCall = new Set(ast.functions.filter((f) => !f.schema).map((f) => f.name.toLowerCase()));
    const seenBuiltin = new Set<string>();

    for (const row of procRes?.rows || []) {
      const fnLower = String(row.proname).toLowerCase();
      if (row.nspname !== 'pg_catalog') {
        if (hasUnqualifiedCall.has(fnLower)) {
          return {
            safe: false,
            reason: `User-defined function overload '${row.nspname}.${row.proname}' exists in visible schema.`,
          };
        }
      } else {
        seenBuiltin.add(fnLower);
        if (row.provolatile === 'v') {
          return {
            safe: false,
            reason: `Built-in pg_catalog function '${row.proname}' has volatile stability.`,
          };
        }
      }
    }

    for (const fn of fnNames) {
      if (!seenBuiltin.has(fn)) {
        return { safe: false, reason: `Function '${fn}' not found in pg_catalog.` };
      }
    }
  }

  // 4. Check pg_operator for any non-pg_catalog operator overloads matching AST operators
  if (ast.operators.size > 0 && nonCatalogSchemas.length > 0) {
    const opNames = Array.from(ast.operators);
    const opRes = await queryable.query<{
      oprname: string;
      oprschema: string;
      fnschema: string;
    }>(
      `SELECT o.oprname, onsp.nspname AS oprschema, COALESCE(fnsp.nspname, 'pg_catalog') AS fnschema
       FROM pg_catalog.pg_operator o
       JOIN pg_catalog.pg_namespace onsp ON onsp.oid = o.oprnamespace
       LEFT JOIN pg_catalog.pg_proc p ON p.oid = o.oprcode
       LEFT JOIN pg_catalog.pg_namespace fnsp ON fnsp.oid = p.pronamespace
       WHERE o.oprname = ANY($1)
         AND (onsp.nspname = ANY($2) OR fnsp.nspname = ANY($2))
         AND (onsp.nspname <> 'pg_catalog' OR COALESCE(fnsp.nspname, 'pg_catalog') <> 'pg_catalog')
       LIMIT 1`,
      [opNames, nonCatalogSchemas],
    );

    if ((opRes?.rows?.length || 0) > 0) {
      const customOp = opRes.rows[0];
      return {
        safe: false,
        reason: `Custom operator '${customOp.oprschema}.${customOp.oprname}' (fn schema '${customOp.fnschema}') detected in visible schemas.`,
      };
    }
  }

  // 5. Check pg_cast for non-pg_catalog cast functions involving AST cast target types or custom schemas
  if (ast.castTargets.size > 0) {
    const targets = Array.from(ast.castTargets);
    const castRes = await queryable.query<{
      srcschema: string;
      srctype: string;
      tgtschema: string;
      tgttype: string;
      fnschema: string;
    }>(
      `SELECT sn.nspname AS srcschema, st.typname AS srctype,
              tn.nspname AS tgtschema, tt.typname AS tgttype,
              pn.nspname AS fnschema
       FROM pg_catalog.pg_cast c
       JOIN pg_catalog.pg_type st ON st.oid = c.castsource
       JOIN pg_catalog.pg_namespace sn ON sn.oid = st.typnamespace
       JOIN pg_catalog.pg_type tt ON tt.oid = c.casttarget
       JOIN pg_catalog.pg_namespace tn ON tn.oid = tt.typnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = c.castfunc
       JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
       WHERE tn.nspname = 'pg_catalog'
         AND tt.typname = ANY($1)
         AND pn.nspname <> 'pg_catalog'
         AND (sn.nspname = 'pg_catalog' OR sn.nspname = ANY($2))
       LIMIT 1`,
      [targets, nonCatalogSchemas],
    );

    if ((castRes?.rows?.length || 0) > 0) {
      const cc = castRes.rows[0];
      return {
        safe: false,
        reason: `Non-pg_catalog cast function detected (${cc.srcschema}.${cc.srctype} -> ${cc.tgtschema}.${cc.tgttype} via schema '${cc.fnschema}').`,
      };
    }
  }

  return { safe: true };
}
