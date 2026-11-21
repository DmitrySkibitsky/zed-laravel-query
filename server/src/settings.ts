/** Server settings: `lsp.laravel-query.settings` (or `initialization_options`) in Zed. */

export interface ConnectionSettings {
  driver?: string;
  url?: string;
  host?: string;
  port?: number;
  socket?: string;
  username?: string;
  password?: string;
  database?: string;
  /** More databases on the same MySQL/MariaDB server to read (cross-database `db.table`). */
  databases?: string[];
  searchPath?: string[] | string;
  prefix?: string;
}

export type Severity = 'error' | 'warning' | 'information' | 'hint';

export interface Settings {
  /** Where connections come from: `auto` (PHP, then .env), `php`, `env`, `off` (settings only). */
  discovery: 'auto' | 'php' | 'env' | 'off';
  /** Command that runs PHP in the project root, e.g. `["docker", "compose", "exec", "-T", "app", "php"]`. */
  php: string[];
  phpTimeout: number;
  /** Extra connections or overrides of discovered ones; `false` drops a connection. */
  connections: Record<string, ConnectionSettings | false | null>;
  defaultConnection?: string;
  /** Connections read at startup besides the default one (others load on first use). */
  eagerConnections: string[];
  cacheDirectory?: string;
  /** Re-read the schema in the background at startup (the cached one is served meanwhile). */
  refreshOnStartup: boolean;
  /** Seconds between checks of the migrations table; a change re-reads the schema. 0 = off. */
  watchMigrations: number;
  migrationPaths: string[];
  /** PhpStorm metadata (files or directories): the classes `app('key')` and container helpers return. */
  metaFiles: string[];
  diagnostics: { enabled: boolean; severity: Severity; unknownTables: boolean; unknownColumns: boolean };
  completion: {
    /** Upper bound for the items of one response. */
    maxItems: number;
    /** `table.column` items for the tables of the query and, filtered by what is typed, all others. */
    qualifiedColumns: boolean;
    /** `database.table.column` items of the other databases/schemas. */
    databaseQualifiedColumns: boolean;
    /** `↺ reset rank` items for columns with usage statistics. */
    resetItems: boolean;
    operators: boolean;
  };
  usage: { enabled: boolean; halfLifeDays: number };
}

export const DEFAULT_SETTINGS: Settings = {
  discovery: 'auto',
  php: ['php'],
  phpTimeout: 20000,
  connections: {},
  eagerConnections: [],
  refreshOnStartup: true,
  watchMigrations: 30,
  migrationPaths: ['database/migrations'],
  metaFiles: ['.phpstorm.meta.php'],
  diagnostics: { enabled: true, severity: 'warning', unknownTables: true, unknownColumns: true },
  completion: {
    maxItems: 400,
    qualifiedColumns: true,
    databaseQualifiedColumns: true,
    resetItems: true,
    operators: true,
  },
  usage: { enabled: true, halfLifeDays: 14 },
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function strings(value: unknown, fallback: string[]): string[] {
  if (typeof value === 'string' && value) {
    return [value];
  }
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : fallback;
}

/** Accepts the settings object itself or one nested under `laravel-query` / `laravelQuery`. */
export function parseSettings(input: unknown): Settings {
  let raw: Json = isObject(input) ? input : {};
  for (const key of ['laravel-query', 'laravelQuery']) {
    if (isObject(raw[key])) {
      raw = raw[key] as Json;
    }
  }
  const d = DEFAULT_SETTINGS;
  const diagnostics = isObject(raw.diagnostics) ? raw.diagnostics : {};
  const completion = isObject(raw.completion) ? raw.completion : {};
  const usage = isObject(raw.usage) ? raw.usage : {};
  const discovery = ['auto', 'php', 'env', 'off'].includes(String(raw.discovery))
    ? (raw.discovery as Settings['discovery'])
    : d.discovery;
  const severity = ['error', 'warning', 'information', 'hint'].includes(String(diagnostics.severity))
    ? (diagnostics.severity as Severity)
    : d.diagnostics.severity;
  const connections: Settings['connections'] = {};
  if (isObject(raw.connections)) {
    for (const [name, value] of Object.entries(raw.connections)) {
      if (value === false || value === null) {
        connections[name] = false;
      } else if (isObject(value)) {
        connections[name] = parseConnection(value);
      }
    }
  }
  return {
    discovery,
    php: strings(raw.php, d.php),
    phpTimeout: num(raw.phpTimeout, d.phpTimeout, 1000),
    connections,
    defaultConnection:
      typeof raw.defaultConnection === 'string' && raw.defaultConnection ? raw.defaultConnection : undefined,
    eagerConnections: strings(raw.eagerConnections, d.eagerConnections),
    cacheDirectory: typeof raw.cacheDirectory === 'string' && raw.cacheDirectory ? raw.cacheDirectory : undefined,
    refreshOnStartup: bool(raw.refreshOnStartup, d.refreshOnStartup),
    watchMigrations: num(raw.watchMigrations, d.watchMigrations),
    migrationPaths: strings(raw.migrationPaths, d.migrationPaths),
    metaFiles: strings(raw.metaFiles, d.metaFiles),
    diagnostics: {
      enabled: bool(diagnostics.enabled, d.diagnostics.enabled),
      severity,
      unknownTables: bool(diagnostics.unknownTables, d.diagnostics.unknownTables),
      unknownColumns: bool(diagnostics.unknownColumns, d.diagnostics.unknownColumns),
    },
    completion: {
      maxItems: num(completion.maxItems, d.completion.maxItems, 20),
      qualifiedColumns: bool(completion.qualifiedColumns, d.completion.qualifiedColumns),
      databaseQualifiedColumns: bool(completion.databaseQualifiedColumns, d.completion.databaseQualifiedColumns),
      resetItems: bool(completion.resetItems, d.completion.resetItems),
      operators: bool(completion.operators, d.completion.operators),
    },
    usage: {
      enabled: bool(usage.enabled, d.usage.enabled),
      halfLifeDays: num(usage.halfLifeDays, d.usage.halfLifeDays, 0.01),
    },
  };
}

function parseConnection(value: Json): ConnectionSettings {
  const out: ConnectionSettings = {};
  for (const key of ['driver', 'url', 'host', 'socket', 'username', 'password', 'database', 'prefix'] as const) {
    if (typeof value[key] === 'string') {
      out[key] = value[key] as string;
    }
  }
  if (typeof value.port === 'number' || (typeof value.port === 'string' && /^\d+$/.test(value.port))) {
    out.port = Number(value.port);
  }
  if (Array.isArray(value.databases)) {
    out.databases = value.databases.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value.searchPath === 'string' || Array.isArray(value.searchPath)) {
    out.searchPath = value.searchPath as string | string[];
  }
  return out;
}
