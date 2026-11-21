/** PostgreSQL introspection through pg_catalog: four queries for every non-system schema. */
import pg from 'pg';
import type { Column, ConnectionConfig, ForeignKey, IntrospectionResult, Table } from '../types.ts';

function quoteIdent(name: string): string {
  return name === '$user' ? name : `"${name.replace(/"/g, '""')}"`;
}

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

async function connect(config: ConnectionConfig): Promise<pg.Client> {
  const client = new pg.Client({
    host: config.socket || config.host || '127.0.0.1',
    port: config.port ?? 5432,
    user: config.username ?? 'postgres',
    password: config.password ?? '',
    database: config.database ?? 'postgres',
    connectionTimeoutMillis: config.timeout ?? 5000,
    application_name: 'laravel-query',
    // Unqualified names (the migrations table) resolve like they do for the application.
    options: config.searchPath?.length ? `-c search_path=${config.searchPath.map(quoteIdent).join(',')}` : undefined,
  });
  await client.connect();
  return client;
}

export async function introspect(config: ConnectionConfig): Promise<IntrospectionResult> {
  const client = await connect(config);
  try {
    const tableRows = await client.query(
      `SELECT n.nspname AS ns, c.relname AS name, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment,
              c.reltuples::bigint AS est
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
          AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%' AND NOT c.relispartition`,
    );
    const columnRows = await client.query(
      `SELECT n.nspname AS ns, c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def,
              col_description(c.oid, a.attnum) AS comment, a.attidentity AS identity, a.attgenerated AS generated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
          AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname, a.attnum`,
    );
    const indexRows = await client.query(
      `SELECT n.nspname AS ns, t.relname AS tbl, i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS prim,
              ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_toast%'`,
    );
    const fkRows = await client.query(
      `SELECT n.nspname AS ns, c.relname AS tbl, con.conname AS name,
              ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
              fn.nspname AS refns, fc.relname AS reftbl,
              ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS refcols
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class fc ON fc.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.contype = 'f' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`,
    );

    const tables = new Map<string, Table>();
    const key = (ns: string, name: string) => `${ns}\u0000${name}`;
    for (const row of tableRows.rows) {
      tables.set(key(row.ns, row.name), {
        name: row.name,
        namespace: row.ns,
        kind: row.kind === 'v' || row.kind === 'm' ? 'view' : 'table',
        comment: row.comment || undefined,
        rows: row.est === null || Number(row.est) < 0 ? undefined : Number(row.est),
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    for (const row of columnRows.rows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const column: Column = { name: row.name, type: row.type, nullable: Boolean(row.nullable) };
      if (row.def !== null && row.def !== undefined) {
        column.default = row.def;
      }
      if (row.identity) {
        column.extra = 'identity';
      } else if (row.generated) {
        column.extra = 'generated';
      } else if (typeof row.def === 'string' && row.def.startsWith('nextval(')) {
        column.extra = 'auto_increment';
      }
      if (row.comment) {
        column.comment = row.comment;
      }
      table.columns.push(column);
    }
    for (const row of indexRows.rows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const columns: string[] = row.cols ?? [];
      table.indexes.push({ name: row.name, columns, unique: Boolean(row.uniq), primary: Boolean(row.prim) });
    }
    for (const row of fkRows.rows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const fk: ForeignKey = {
        name: row.name,
        columns: row.cols ?? [],
        foreignTable: row.refns !== row.ns ? `${row.refns}.${row.reftbl}` : row.reftbl,
        foreignColumns: row.refcols ?? [],
      };
      table.foreignKeys.push(fk);
    }
    markKeys(tables.values());
    const namespaces = [...new Set([...tables.values()].map((t) => t.namespace))].sort();
    const searchPath = (config.searchPath?.length ? config.searchPath : ['public']).map((s) =>
      s === '$user' ? (config.username ?? '') : s,
    );
    return {
      defaultNamespaces: searchPath.filter((s) => s && (namespaces.includes(s) || s === 'public')),
      namespaces,
      tables: [...tables.values()],
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** PostgreSQL has no COLUMN_KEY: derive PRI/UNI/MUL from the indexes. */
function markKeys(tables: Iterable<Table>): void {
  for (const table of tables) {
    const byName = new Map(table.columns.map((c) => [c.name, c]));
    for (const index of table.indexes) {
      const first = byName.get(index.columns[0] ?? '');
      if (!first) {
        continue;
      }
      const key = index.primary ? 'PRI' : index.unique && index.columns.length === 1 ? 'UNI' : 'MUL';
      if (!first.key || key === 'PRI') {
        first.key = key;
      }
    }
  }
}

export async function migrationsMarker(config: ConnectionConfig, table: string): Promise<string | undefined> {
  let client: pg.Client | undefined;
  try {
    client = await connect(config);
    const rows = await client.query(
      `SELECT COUNT(*) AS c, MAX(id) AS m FROM ${quoteIdent(`${config.prefix ?? ''}${table}`)}`,
    );
    const ddl = await client.query(
      `SELECT COUNT(*) AS t, COALESCE(SUM(c.relnatts), 0) AS a FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'v', 'm', 'p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`,
    );
    return `${rows.rows[0]?.c}:${rows.rows[0]?.m}:${ddl.rows[0]?.t}:${ddl.rows[0]?.a}`;
  } catch {
    return undefined;
  } finally {
    await client?.end().catch(() => undefined);
  }
}
