/**
 * SQLite introspection with Node's built-in `node:sqlite` (Node.js >= 22.13). Opened read-only;
 * when the module is missing (older Node.js) the connection reports a clear error instead.
 */
import * as fs from 'node:fs';
import type { Column, ConnectionConfig, IntrospectionResult, Table } from '../types.ts';

interface Statement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface Database {
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseSyncConstructor = new (path: string, options?: { readOnly?: boolean }) => Database;

function loadSqlite(): DatabaseSyncConstructor {
  // getBuiltinModule keeps the bundler away from the built-in module and returns undefined on
  // Node.js versions without it.
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  let module: { DatabaseSync?: DatabaseSyncConstructor } | undefined;
  try {
    module = getBuiltin?.call(process, 'node:sqlite') as typeof module;
  } catch {
    module = undefined;
  }
  if (!module?.DatabaseSync) {
    throw new Error(
      `SQLite needs Node.js >= 22.13 (node:sqlite), this is ${process.version}. Set lsp.laravel-query.binary.path to a newer node.`,
    );
  }
  return module.DatabaseSync;
}

function open(config: ConnectionConfig): Database {
  const file = config.database;
  if (!file || file === ':memory:') {
    throw new Error('SQLite connection without a database file');
  }
  if (!fs.existsSync(file)) {
    throw new Error(`SQLite database ${file} does not exist`);
  }
  const DatabaseSync = loadSqlite();
  return new DatabaseSync(file, { readOnly: true });
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function introspect(config: ConnectionConfig): Promise<IntrospectionResult> {
  const db = open(config);
  try {
    const tables: Table[] = [];
    const objects = db
      .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`)
      .all();
    for (const object of objects) {
      const name = String(object.name);
      const columns: Column[] = db
        .prepare(`PRAGMA table_xinfo(${quote(name)})`)
        .all()
        .filter((c) => Number(c.hidden ?? 0) === 0 || Number(c.hidden) >= 2)
        .map((c) => {
          const column: Column = {
            name: String(c.name),
            type: String(c.type || '').toLowerCase() || 'any',
            nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
          };
          if (c.dflt_value !== null && c.dflt_value !== undefined) {
            column.default = String(c.dflt_value);
          }
          if (Number(c.pk) > 0) {
            column.key = 'PRI';
          }
          return column;
        });
      const table: Table = {
        name,
        namespace: 'main',
        kind: object.type === 'view' ? 'view' : 'table',
        columns,
        indexes: [],
        foreignKeys: [],
      };
      if (object.type === 'table') {
        for (const index of db.prepare(`PRAGMA index_list(${quote(name)})`).all()) {
          const indexColumns = db
            .prepare(`PRAGMA index_info(${quote(String(index.name))})`)
            .all()
            .map((c) => String(c.name));
          table.indexes.push({
            name: String(index.name),
            columns: indexColumns,
            unique: Number(index.unique) === 1,
            primary: index.origin === 'pk',
          });
          const first = columns.find((c) => c.name === indexColumns[0]);
          if (first && !first.key) {
            first.key = Number(index.unique) === 1 && indexColumns.length === 1 ? 'UNI' : 'MUL';
          }
        }
        const fks = new Map<number, Table['foreignKeys'][number]>();
        for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()) {
          const id = Number(fk.id);
          let entry = fks.get(id);
          if (!entry) {
            entry = { name: `${name}_fk_${id}`, columns: [], foreignTable: String(fk.table), foreignColumns: [] };
            fks.set(id, entry);
          }
          entry.columns.push(String(fk.from));
          entry.foreignColumns.push(String(fk.to ?? 'id'));
        }
        table.foreignKeys = [...fks.values()];
      }
      tables.push(table);
    }
    return { defaultNamespaces: ['main'], namespaces: ['main'], tables };
  } finally {
    db.close();
  }
}

export async function migrationsMarker(config: ConnectionConfig, table: string): Promise<string | undefined> {
  try {
    const stat = fs.statSync(config.database ?? '');
    const db = open(config);
    try {
      const rows = db
        .prepare(`SELECT COUNT(*) AS c, MAX(id) AS m FROM ${quote(`${config.prefix ?? ''}${table}`)}`)
        .all();
      return `${rows[0]?.c}:${rows[0]?.m}:${stat.size}`;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
