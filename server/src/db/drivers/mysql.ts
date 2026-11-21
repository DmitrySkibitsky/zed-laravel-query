/** MySQL / MariaDB introspection through information_schema: four queries per connection. */
import * as fs from 'node:fs';
import { type Connection, createConnection, type RowDataPacket } from 'mysql2/promise';
import type { Column, ConnectionConfig, ForeignKey, Index, IntrospectionResult, Table } from '../types.ts';

const DEFAULT_SOCKETS = [
  '/run/mysqld/mysqld.sock',
  '/var/run/mysqld/mysqld.sock',
  '/tmp/mysql.sock',
  '/var/lib/mysql/mysql.sock',
  '/opt/homebrew/var/mysql/mysql.sock',
  '/usr/local/var/mysql/mysql.sock',
];

/**
 * PHP's PDO connects to `localhost` through the default Unix socket, not TCP; do the same so a
 * server that only listens on its socket (or on 127.0.0.1 but not ::1) is reached.
 */
export function socketFor(
  config: ConnectionConfig,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  if (config.socket) {
    return config.socket;
  }
  if (config.host !== 'localhost' || process.platform === 'win32') {
    return undefined;
  }
  return DEFAULT_SOCKETS.find((file) => exists(file));
}

async function connect(config: ConnectionConfig): Promise<Connection> {
  const socket = socketFor(config);
  return createConnection({
    host: socket ? undefined : config.host === 'localhost' ? '127.0.0.1' : (config.host ?? '127.0.0.1'),
    port: socket ? undefined : (config.port ?? 3306),
    socketPath: socket,
    user: config.username ?? 'root',
    password: config.password ?? '',
    database: undefined,
    connectTimeout: config.timeout ?? 5000,
    // Reading the schema never needs more than plain rows.
    rowsAsArray: false,
    dateStrings: true,
    supportBigNumbers: true,
    multipleStatements: false,
  });
}

function namespacesOf(config: ConnectionConfig): string[] {
  const all = [config.database, ...(config.databases ?? [])].filter((d): d is string => Boolean(d));
  return [...new Set(all)];
}

export async function introspect(config: ConnectionConfig): Promise<IntrospectionResult> {
  const namespaces = namespacesOf(config);
  if (namespaces.length === 0) {
    return { defaultNamespaces: [], namespaces: [], tables: [] };
  }
  const connection = await connect(config);
  try {
    const placeholders = namespaces.map(() => '?').join(',');
    const [tableRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS ns, TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_COMMENT AS comment, TABLE_ROWS AS est
         FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${placeholders})`,
      namespaces,
    );
    const [columnRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS ns, TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, COLUMN_KEY AS ckey, EXTRA AS extra,
              COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${placeholders})
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      namespaces,
    );
    const [indexRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS ns, TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
              COLUMN_NAME AS col
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${placeholders})
        ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      namespaces,
    );
    const [fkRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS ns, TABLE_NAME AS tbl, CONSTRAINT_NAME AS name, COLUMN_NAME AS col,
              REFERENCED_TABLE_SCHEMA AS refNs, REFERENCED_TABLE_NAME AS refTbl, REFERENCED_COLUMN_NAME AS refCol
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA IN (${placeholders}) AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      namespaces,
    );

    const tables = new Map<string, Table>();
    const key = (ns: string, name: string) => `${ns}\u0000${name}`;
    for (const row of tableRows) {
      tables.set(key(row.ns, row.name), {
        name: row.name,
        namespace: row.ns,
        kind: String(row.type).includes('VIEW') ? 'view' : 'table',
        comment: row.comment || undefined,
        rows: row.est === null || row.est === undefined ? undefined : Number(row.est),
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    for (const row of columnRows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const column: Column = {
        name: row.name,
        type: String(row.type),
        nullable: row.nullable === 'YES',
      };
      if (row.def !== null && row.def !== undefined) {
        column.default = String(row.def);
      }
      if (row.ckey) {
        column.key = row.ckey;
      }
      if (row.extra) {
        column.extra = row.extra;
      }
      if (row.comment) {
        column.comment = row.comment;
      }
      table.columns.push(column);
    }
    let lastIndex: Index | undefined;
    let lastIndexKey = '';
    for (const row of indexRows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const indexKey = `${row.ns}.${row.tbl}.${row.name}`;
      if (indexKey !== lastIndexKey || !lastIndex) {
        lastIndex = {
          name: row.name,
          columns: [],
          unique: Number(row.nonUnique) === 0,
          primary: row.name === 'PRIMARY',
        };
        table.indexes.push(lastIndex);
        lastIndexKey = indexKey;
      }
      if (row.col) {
        lastIndex.columns.push(row.col);
      }
    }
    let lastFk: ForeignKey | undefined;
    let lastFkKey = '';
    for (const row of fkRows) {
      const table = tables.get(key(row.ns, row.tbl));
      if (!table) {
        continue;
      }
      const fkKey = `${row.ns}.${row.tbl}.${row.name}`;
      if (fkKey !== lastFkKey || !lastFk) {
        lastFk = {
          name: row.name,
          columns: [],
          foreignTable: row.refNs && row.refNs !== row.ns ? `${row.refNs}.${row.refTbl}` : row.refTbl,
          foreignColumns: [],
        };
        table.foreignKeys.push(lastFk);
        lastFkKey = fkKey;
      }
      lastFk.columns.push(row.col);
      lastFk.foreignColumns.push(row.refCol);
    }
    return {
      defaultNamespaces: config.database ? [config.database] : namespaces.slice(0, 1),
      namespaces,
      tables: [...tables.values()],
    };
  } finally {
    await connection.end().catch(() => undefined);
  }
}

export async function migrationsMarker(config: ConnectionConfig, table: string): Promise<string | undefined> {
  if (!config.database) {
    return undefined;
  }
  const connection = await connect(config);
  try {
    const name = `${config.prefix ?? ''}${table}`;
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c, MAX(id) AS m FROM \`${config.database.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``,
    );
    const [ddl] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS t, COALESCE(MAX(UNIX_TIMESTAMP(CREATE_TIME)), 0) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [config.database],
    );
    return `${rows[0]?.c}:${rows[0]?.m}:${ddl[0]?.t}:${ddl[0]?.c}`;
  } catch {
    return undefined;
  } finally {
    await connection.end().catch(() => undefined);
  }
}
