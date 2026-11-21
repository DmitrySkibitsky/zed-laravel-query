/** Database schema model shared by the drivers, the cache and the language features. */

export type Driver = 'mysql' | 'mariadb' | 'pgsql' | 'sqlite';

export const SUPPORTED_DRIVERS: readonly Driver[] = ['mysql', 'mariadb', 'pgsql', 'sqlite'];

/** A Laravel connection as far as introspection needs it. */
export interface ConnectionConfig {
  name: string;
  driver: Driver;
  host?: string;
  port?: number;
  socket?: string;
  username?: string;
  password?: string;
  /** Default database (MySQL/MariaDB/PostgreSQL) or the database file (SQLite). */
  database?: string;
  /** Extra databases on the same server (MySQL/MariaDB) to read, besides `database`. */
  databases?: string[];
  /** PostgreSQL: schemas searched for unqualified names (Laravel's `search_path`). */
  searchPath?: string[];
  /** Laravel table prefix: stripped from the table names the code uses. */
  prefix?: string;
  /** Where the config came from, for status messages. */
  source?: 'php' | 'env' | 'settings';
  /** Connect timeout in milliseconds. */
  timeout?: number;
}

export interface Column {
  name: string;
  /** Full type as the database reports it, e.g. `varchar(255)`, `bigint unsigned`. */
  type: string;
  nullable: boolean;
  default?: string | null;
  /** `PRI`, `UNI`, `MUL` (MySQL `COLUMN_KEY`) or derived from indexes. */
  key?: string;
  /** e.g. `auto_increment`, `on update current_timestamp()` */
  extra?: string;
  comment?: string;
}

export interface Index {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  /** Referenced table, `namespace.table` when in another namespace. */
  foreignTable: string;
  foreignColumns: string[];
}

export interface Table {
  /** Name as the code uses it (without the connection prefix). */
  name: string;
  /** Database (MySQL/MariaDB), schema (PostgreSQL) or `main` (SQLite). */
  namespace: string;
  kind: 'table' | 'view';
  comment?: string;
  /** Row estimate from the database statistics. */
  rows?: number;
  columns: Column[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
}

/** Everything read from one connection. */
export interface ConnectionSchema {
  connection: string;
  driver: Driver;
  /** Namespaces searched for unqualified table names, in order. */
  defaultNamespaces: string[];
  /** Every namespace that was read. */
  namespaces: string[];
  tables: Table[];
  /** When it was read (ms since epoch). */
  loadedAt: number;
  /** How long reading took (ms). */
  duration: number;
  /** Identifies the server/database the schema belongs to (no credentials). */
  fingerprint: string;
}

/** What a driver returns: the raw schema of the requested namespaces. */
export interface IntrospectionResult {
  defaultNamespaces: string[];
  namespaces: string[];
  tables: Table[];
}

export interface DriverModule {
  introspect(config: ConnectionConfig): Promise<IntrospectionResult>;
  /** Cheap fingerprint of applied migrations (count/max id) to notice `php artisan migrate`. */
  migrationsMarker?(config: ConnectionConfig, table: string): Promise<string | undefined>;
}

export function connectionFingerprint(config: ConnectionConfig): string {
  const databases = [config.database ?? '', ...(config.databases ?? [])].join(',');
  const where = config.driver === 'sqlite' ? '' : `${config.socket ?? `${config.host ?? ''}:${config.port ?? ''}`}`;
  return `${config.driver}|${where}|${databases}|${(config.searchPath ?? []).join(',')}|${config.prefix ?? ''}`;
}

export function isMysqlFamily(driver: Driver): boolean {
  return driver === 'mysql' || driver === 'mariadb';
}
