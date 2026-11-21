/**
 * Schemas of the project's connections: read through the drivers, kept in memory with lookup
 * indexes, cached on disk (served instantly at the next start, refreshed in the background),
 * re-read when the migrations table changes or on request.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type Column,
  type ConnectionConfig,
  type ConnectionSchema,
  connectionFingerprint,
  type DriverModule,
  isMysqlFamily,
  type Table,
} from './types.ts';

const CACHE_VERSION = 1;

export interface ColumnEntry {
  table: Table;
  column: Column;
  /** Lower-cased column name. */
  lower: string;
}

/** One connection's schema with the lookups completion needs. */
export class SchemaIndex {
  readonly schema: ConnectionSchema;
  readonly caseSensitive: boolean;
  private readonly byNamespace = new Map<string, Map<string, Table>>();
  private readonly columnsByNamespace = new Map<string, ColumnEntry[]>();
  private readonly columnMaps = new WeakMap<Table, Map<string, Column>>();

  constructor(schema: ConnectionSchema) {
    this.schema = schema;
    // MySQL table names follow the file system (lower_case_table_names); compare case-insensitively
    // there and on SQLite, exactly on PostgreSQL.
    this.caseSensitive = schema.driver === 'pgsql';
    for (const table of schema.tables) {
      let tables = this.byNamespace.get(table.namespace);
      if (!tables) {
        tables = new Map();
        this.byNamespace.set(table.namespace, tables);
      }
      tables.set(this.norm(table.name), table);
      let columns = this.columnsByNamespace.get(table.namespace);
      if (!columns) {
        columns = [];
        this.columnsByNamespace.set(table.namespace, columns);
      }
      for (const column of table.columns) {
        columns.push({ table, column, lower: column.name.toLowerCase() });
      }
    }
  }

  get connection(): string {
    return this.schema.connection;
  }

  norm(name: string): string {
    return this.caseSensitive ? name : name.toLowerCase();
  }

  get defaultNamespaces(): string[] {
    return this.schema.defaultNamespaces;
  }

  get namespaces(): string[] {
    return this.schema.namespaces;
  }

  hasNamespace(name: string): boolean {
    return this.byNamespace.has(name) || this.schema.namespaces.includes(name);
  }

  /** `table` (searched in the default namespaces) or `namespace.table`. */
  findTable(reference: string): Table | undefined {
    const dot = reference.indexOf('.');
    if (dot > 0) {
      const ns = reference.slice(0, dot);
      const name = reference.slice(dot + 1);
      const inNamespace = this.findNamespace(ns)?.get(this.norm(name));
      if (inNamespace) {
        return inNamespace;
      }
    }
    for (const ns of this.schema.defaultNamespaces) {
      const table = this.byNamespace.get(ns)?.get(this.norm(reference));
      if (table) {
        return table;
      }
    }
    return undefined;
  }

  private findNamespace(name: string): Map<string, Table> | undefined {
    const exact = this.byNamespace.get(name);
    if (exact || this.caseSensitive) {
      return exact;
    }
    const lower = name.toLowerCase();
    for (const [ns, tables] of this.byNamespace) {
      if (ns.toLowerCase() === lower) {
        return tables;
      }
    }
    return undefined;
  }

  tablesIn(namespace: string): Table[] {
    return [...(this.findNamespace(namespace)?.values() ?? [])];
  }

  defaultTables(): Table[] {
    return this.schema.defaultNamespaces.flatMap((ns) => this.tablesIn(ns));
  }

  columnsIn(namespace: string): ColumnEntry[] {
    return this.columnsByNamespace.get(namespace) ?? [];
  }

  /** Whether `table` is reachable without its namespace. */
  isDefault(table: Table): boolean {
    return this.schema.defaultNamespaces.includes(table.namespace);
  }

  /** Name as code refers to it: bare in a default namespace, `namespace.table` elsewhere. */
  reference(table: Table): string {
    return this.isDefault(table) ? table.name : `${table.namespace}.${table.name}`;
  }

  column(table: Table, name: string): Column | undefined {
    let map = this.columnMaps.get(table);
    if (!map) {
      map = new Map(table.columns.map((c) => [c.name.toLowerCase(), c]));
      this.columnMaps.set(table, map);
    }
    return map.get(name.toLowerCase());
  }

  get columnCount(): number {
    let count = 0;
    for (const columns of this.columnsByNamespace.values()) {
      count += columns.length;
    }
    return count;
  }
}

export interface ConnectionState {
  config: ConnectionConfig;
  index?: SchemaIndex;
  loading?: Promise<SchemaIndex | undefined>;
  error?: string;
  failedAt?: number;
  /** Last seen migrations marker. */
  marker?: string;
}

export interface SchemaStoreOptions {
  cacheDir: string;
  drivers: Record<string, () => Promise<DriverModule>>;
  log: (message: string) => void;
  /** Called after a connection's schema changed (loaded, refreshed). */
  onChange?: (connection: string) => void;
}

const RETRY_AFTER_FAILURE_MS = 60_000;

export class SchemaStore {
  private readonly states = new Map<string, ConnectionState>();
  defaultConnection = '';
  migrationsTable = 'migrations';
  private readonly options: SchemaStoreOptions;
  private watchTimer: NodeJS.Timeout | undefined;

  constructor(options: SchemaStoreOptions) {
    this.options = options;
  }

  get cacheDir(): string {
    return this.options.cacheDir;
  }

  /** Replaces the known connections; schemas of unchanged connections are kept. */
  setConnections(configs: ConnectionConfig[], defaultConnection: string): void {
    const next = new Map<string, ConnectionState>();
    for (const config of configs) {
      const previous = this.states.get(config.name);
      if (previous && connectionFingerprint(previous.config) === connectionFingerprint(config)) {
        previous.config = config;
        next.set(config.name, previous);
      } else {
        next.set(config.name, { config, index: this.readCache(config) });
      }
    }
    this.states.clear();
    for (const [name, state] of next) {
      this.states.set(name, state);
    }
    this.defaultConnection = defaultConnection;
  }

  connectionNames(): string[] {
    return [...this.states.keys()];
  }

  config(name?: string): ConnectionConfig | undefined {
    return this.states.get(name || this.defaultConnection)?.config;
  }

  state(name?: string): ConnectionState | undefined {
    return this.states.get(name || this.defaultConnection);
  }

  /** Loaded schema of a connection (default when omitted); starts loading it when missing. */
  get(name?: string): SchemaIndex | undefined {
    const state = this.states.get(name || this.defaultConnection);
    if (!state) {
      return undefined;
    }
    if (!state.index && !state.loading && (!state.failedAt || Date.now() - state.failedAt > RETRY_AFTER_FAILURE_MS)) {
      void this.refresh(state.config.name);
    }
    return state.index;
  }

  /** Loaded schemas only, without triggering loads. */
  loaded(): SchemaIndex[] {
    return [...this.states.values()].flatMap((s) => (s.index ? [s.index] : []));
  }

  /** Schemas of the same server as `index` (cross-database references on MySQL/MariaDB). */
  siblings(index: SchemaIndex): SchemaIndex[] {
    const config = this.states.get(index.connection)?.config;
    if (!config || !isMysqlFamily(config.driver)) {
      return [];
    }
    const server = (c: ConnectionConfig) => `${c.socket ?? `${c.host}:${c.port}`}`;
    return this.loaded().filter((other) => {
      const otherConfig = this.states.get(other.connection)?.config;
      return (
        other !== index && otherConfig && isMysqlFamily(otherConfig.driver) && server(otherConfig) === server(config)
      );
    });
  }

  /** Waits for a connection's schema (used by tests and commands). */
  async ready(name?: string): Promise<SchemaIndex | undefined> {
    const state = this.states.get(name || this.defaultConnection);
    if (!state) {
      return undefined;
    }
    if (state.loading) {
      return state.loading;
    }
    return state.index ?? this.refresh(state.config.name);
  }

  /** Reads the schema from the database; concurrent calls share one read. */
  refresh(name?: string): Promise<SchemaIndex | undefined> {
    const state = this.states.get(name || this.defaultConnection);
    if (!state) {
      return Promise.resolve(undefined);
    }
    if (state.loading) {
      return state.loading;
    }
    const config = state.config;
    state.loading = (async () => {
      const started = Date.now();
      try {
        const loader =
          this.options.drivers[config.driver] ?? this.options.drivers[isMysqlFamily(config.driver) ? 'mysql' : ''];
        if (!loader) {
          throw new Error(`unsupported driver ${config.driver}`);
        }
        const driver = await loader();
        const result = await driver.introspect(config);
        const prefix = config.prefix ?? '';
        const tables = prefix
          ? result.tables.flatMap((t) =>
              t.name.startsWith(prefix) ? [{ ...t, name: t.name.slice(prefix.length) }] : [],
            )
          : result.tables;
        const schema: ConnectionSchema = {
          connection: config.name,
          driver: config.driver,
          defaultNamespaces: result.defaultNamespaces,
          namespaces: result.namespaces,
          tables,
          loadedAt: Date.now(),
          duration: Date.now() - started,
          fingerprint: connectionFingerprint(config),
        };
        const index = new SchemaIndex(schema);
        if (this.states.get(config.name) === state) {
          state.index = index;
          state.error = undefined;
          state.failedAt = undefined;
          this.writeCache(schema);
        }
        this.options.log(
          `laravel-query: schema of ${config.name} read: ${tables.length} tables, ${index.columnCount} columns in ${schema.duration} ms`,
        );
        this.options.onChange?.(config.name);
        return index;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        state.failedAt = Date.now();
        this.options.log(`laravel-query: reading the schema of ${config.name} failed: ${state.error}`);
        return state.index;
      } finally {
        state.loading = undefined;
      }
    })();
    return state.loading;
  }

  /** Polls the migrations table of the loaded connections; a change re-reads that schema. */
  watch(seconds: number): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (seconds <= 0) {
      return;
    }
    this.watchTimer = setInterval(() => void this.checkMigrations(), seconds * 1000);
    this.watchTimer.unref();
  }

  async checkMigrations(): Promise<void> {
    for (const state of this.states.values()) {
      if (!state.index || state.loading) {
        continue;
      }
      try {
        const loader =
          this.options.drivers[state.config.driver] ??
          this.options.drivers[isMysqlFamily(state.config.driver) ? 'mysql' : ''];
        const driver = await loader?.();
        const marker = await driver?.migrationsMarker?.(state.config, this.migrationsTable);
        if (marker === undefined) {
          continue;
        }
        if (state.marker !== undefined && state.marker !== marker) {
          this.options.log(`laravel-query: migrations of ${state.config.name} changed, re-reading the schema`);
          await this.refresh(state.config.name);
        }
        state.marker = marker;
      } catch {
        // Unreachable database: keep the cached schema.
      }
    }
  }

  dispose(): void {
    this.watch(0);
  }

  private cacheFile(config: ConnectionConfig): string {
    const safe = config.name.replace(/[^\w.-]/g, '_');
    return path.join(this.options.cacheDir, `schema-${safe}.json`);
  }

  private readCache(config: ConnectionConfig): SchemaIndex | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile(config), 'utf8')) as {
        version: number;
        schema: ConnectionSchema;
      };
      if (data.version !== CACHE_VERSION || data.schema.fingerprint !== connectionFingerprint(config)) {
        return undefined;
      }
      return new SchemaIndex(data.schema);
    } catch {
      return undefined;
    }
  }

  private writeCache(schema: ConnectionSchema): void {
    const config = this.states.get(schema.connection)?.config;
    if (!config) {
      return;
    }
    try {
      fs.mkdirSync(this.options.cacheDir, { recursive: true });
      const file = this.cacheFile(config);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, schema }));
      fs.renameSync(temp, file);
    } catch (error) {
      this.options.log(`laravel-query: cannot write the schema cache: ${String(error)}`);
    }
  }
}

/** Per-project cache directory: `<base>/<project name>-<hash of its path>`. */
export function projectCacheDir(base: string, root: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(base, `${path.basename(root).replace(/[^\w.-]/g, '_') || 'project'}-${hash}`);
}

/** The OS cache directory for this server. */
export function defaultCacheBase(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'laravel-query');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'laravel-query');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'laravel-query');
}
