/**
 * Finds the project's database connections:
 * 1. `php` boots the Laravel application and prints `config('database')` — exact, with every
 *    env() default, ternary and package override applied;
 * 2. without PHP (or when booting fails) the `DB_*` variables of `.env` describe the default
 *    connection;
 * 3. `connections` in the Zed settings adds connections or overrides fields of discovered ones
 *    (e.g. `host` when PHP runs in a container).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConnectionSettings, Settings } from '../settings.ts';
import { type ConnectionConfig, type Driver, SUPPORTED_DRIVERS } from './types.ts';

export interface DiscoveredConnections {
  defaultConnection: string;
  connections: ConnectionConfig[];
  /** Laravel's migrations table name. */
  migrationsTable: string;
  source: 'php' | 'env' | 'settings' | 'none';
  /** Why the preferred source was not used. */
  warnings: string[];
}

const MARKER = '__LARAVEL_QUERY__';

/** Boots the application like artisan does and prints the database config between markers. */
export const PHP_CONFIG_SCRIPT = [
  'error_reporting(E_ERROR);',
  '$root = getcwd();',
  "require $root . '/vendor/autoload.php';",
  "$app = require $root . '/bootstrap/app.php';",
  '$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();',
  "$config = $app['config'];",
  `echo "\\n${MARKER}", json_encode(['default' => $config->get('database.default'), 'connections' => $config->get('database.connections'), 'migrations' => $config->get('database.migrations')], JSON_PARTIAL_OUTPUT_ON_ERROR), "${MARKER}\\n";`,
].join(' ');

type Raw = Record<string, unknown>;

export async function discoverConnections(
  root: string,
  settings: Settings,
  log: (message: string) => void,
): Promise<DiscoveredConnections> {
  const warnings: string[] = [];
  let discovered: { defaultConnection: string; raw: Record<string, Raw>; migrations: unknown } | undefined;
  let source: DiscoveredConnections['source'] = 'none';
  const env = readEnvFile(path.join(root, '.env'));

  if (settings.discovery === 'auto' || settings.discovery === 'php') {
    if (
      fs.existsSync(path.join(root, 'vendor', 'autoload.php')) &&
      fs.existsSync(path.join(root, 'bootstrap', 'app.php'))
    ) {
      try {
        const output = await runPhp(settings.php, root, settings.phpTimeout);
        discovered = parsePhpOutput(output);
        source = 'php';
      } catch (error) {
        warnings.push(`reading config through PHP failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warnings.push(
        'no vendor/autoload.php or bootstrap/app.php: not a Laravel application with dependencies installed',
      );
    }
  }
  if (!discovered && (settings.discovery === 'auto' || settings.discovery === 'env' || settings.discovery === 'php')) {
    if (env) {
      discovered = fromEnv(env);
      source = 'env';
    }
  }

  const connections = new Map<string, ConnectionConfig>();
  for (const [name, raw] of Object.entries(discovered?.raw ?? {})) {
    const config = normalizeConnection(name, raw, root, source === 'php' ? 'php' : 'env');
    if (config) {
      connections.set(name, config);
    }
  }
  for (const [name, override] of Object.entries(settings.connections)) {
    if (override === false || override === null) {
      connections.delete(name);
      continue;
    }
    const base = connections.get(name);
    const merged = applyOverride(name, base, override, root);
    if (merged) {
      connections.set(name, merged);
      if (source === 'none') {
        source = 'settings';
      }
    } else {
      warnings.push(`connection ${name}: no supported driver (${SUPPORTED_DRIVERS.join(', ')})`);
    }
  }

  let defaultConnection = settings.defaultConnection ?? discovered?.defaultConnection ?? '';
  if (!connections.has(defaultConnection)) {
    defaultConnection = connections.keys().next().value ?? '';
  }
  for (const warning of warnings) {
    log(`laravel-query: ${warning}`);
  }
  return {
    defaultConnection,
    connections: [...connections.values()],
    migrationsTable: migrationsTableName(discovered?.migrations),
    source,
    warnings,
  };
}

function migrationsTableName(value: unknown): string {
  if (typeof value === 'string' && value) {
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as Raw).table === 'string') {
    return (value as Raw).table as string;
  }
  return 'migrations';
}

function runPhp(command: string[], cwd: string, timeout: number): Promise<string> {
  const [program, ...args] = command.length ? command : ['php'];
  return new Promise((resolve, reject) => {
    execFile(
      program,
      [...args, '-r', PHP_CONFIG_SCRIPT],
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, APP_RUNNING_IN_CONSOLE: 'true' } },
      (error, stdout, stderr) => {
        if (stdout.includes(MARKER)) {
          resolve(stdout);
          return;
        }
        const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
        reject(
          new Error(error ? `${error.message.split('\n')[0]}${detail ? `: ${detail}` : ''}` : detail || 'no output'),
        );
      },
    );
  });
}

export function parsePhpOutput(output: string): {
  defaultConnection: string;
  raw: Record<string, Raw>;
  migrations: unknown;
} {
  const start = output.indexOf(MARKER);
  const end = output.indexOf(MARKER, start + MARKER.length);
  if (start < 0 || end < 0) {
    throw new Error('unexpected output');
  }
  const data = JSON.parse(output.slice(start + MARKER.length, end)) as Raw;
  const connections = (data.connections && typeof data.connections === 'object' ? data.connections : {}) as Record<
    string,
    Raw
  >;
  return { defaultConnection: String(data.default ?? ''), raw: connections, migrations: data.migrations };
}

const DEFAULT_PORTS: Partial<Record<Driver, number>> = { mysql: 3306, mariadb: 3306, pgsql: 5432 };

function asDriver(value: unknown): Driver | undefined {
  const driver = String(value ?? '').toLowerCase();
  if (driver === 'postgres' || driver === 'postgresql') {
    return 'pgsql';
  }
  return (SUPPORTED_DRIVERS as readonly string[]).includes(driver) ? (driver as Driver) : undefined;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  return String(value);
}

function firstHost(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return str(value[0]);
  }
  return str(value);
}

/** Laravel connection array (config/database.php) → ConnectionConfig; undefined for other drivers. */
export function normalizeConnection(
  name: string,
  raw: Raw,
  root: string,
  source: ConnectionConfig['source'],
): ConnectionConfig | undefined {
  const merged: Raw = { ...raw };
  // read/write split: the write host is where migrations run.
  const write = (raw.write ?? raw.read) as Raw | undefined;
  if (write && typeof write === 'object' && merged.host === undefined) {
    merged.host = write.host;
  }
  const url = str(raw.url);
  if (url) {
    Object.assign(merged, parseDatabaseUrl(url));
  }
  const driver = asDriver(merged.driver);
  if (!driver) {
    return undefined;
  }
  const config: ConnectionConfig = { name, driver, source };
  if (driver === 'sqlite') {
    const database = str(merged.database);
    config.database =
      database && database !== ':memory:' && !path.isAbsolute(database) ? path.join(root, database) : database;
  } else {
    config.host = firstHost(merged.host) ?? '127.0.0.1';
    const port = Number(merged.port);
    config.port = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORTS[driver];
    config.socket = str(merged.unix_socket);
    config.username = str(merged.username);
    config.password = merged.password === null || merged.password === undefined ? undefined : String(merged.password);
    config.database = str(merged.database);
  }
  if (driver === 'pgsql') {
    const searchPath = merged.search_path ?? merged.schema;
    config.searchPath = parseSearchPath(searchPath);
  }
  config.prefix = str(merged.prefix);
  return config;
}

function parseSearchPath(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return undefined;
}

/** `mysql://user:pass@host:3306/db?x=y` → connection fields (what Laravel's DB_URL does). */
export function parseDatabaseUrl(url: string): Raw {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '');
    const driver = { postgres: 'pgsql', postgresql: 'pgsql', mysql2: 'mysql', sqlite3: 'sqlite' }[scheme] ?? scheme;
    const out: Raw = { driver };
    if (parsed.hostname) {
      out.host = decodeURIComponent(parsed.hostname);
    }
    if (parsed.port) {
      out.port = Number(parsed.port);
    }
    if (parsed.username) {
      out.username = decodeURIComponent(parsed.username);
    }
    if (parsed.password) {
      out.password = decodeURIComponent(parsed.password);
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (database) {
      out.database = database;
    }
    for (const [key, value] of parsed.searchParams) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function applyOverride(
  name: string,
  base: ConnectionConfig | undefined,
  override: ConnectionSettings,
  root: string,
): ConnectionConfig | undefined {
  const raw: Raw = {
    driver: override.driver ?? base?.driver,
    url: override.url,
    host: override.host ?? base?.host,
    port: override.port ?? base?.port,
    unix_socket: override.socket ?? base?.socket,
    username: override.username ?? base?.username,
    password: override.password ?? base?.password,
    database: override.database ?? base?.database,
    search_path: override.searchPath ?? base?.searchPath,
    prefix: override.prefix ?? base?.prefix,
  };
  const config = normalizeConnection(name, raw, root, 'settings');
  if (!config) {
    return undefined;
  }
  config.databases = override.databases ?? base?.databases;
  if (base?.source && !override.driver && !override.url) {
    config.source = base.source;
  }
  return config;
}

// --- .env ---------------------------------------------------------------------------------

export function readEnvFile(file: string): Record<string, string> | undefined {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** dotenv syntax as phpdotenv reads it: quotes, `export`, inline comments, `${VAR}` expansion. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const expand = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => env[key] ?? process.env[key] ?? '');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let body = value.slice(1);
      // Multi-line quoted values
      while (!hasClosingQuote(body, quote) && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i]}`;
      }
      const close = closingQuoteIndex(body, quote);
      body = close < 0 ? body : body.slice(0, close);
      if (quote === '"') {
        body = expand(body.replace(/\\(["\\$nrt])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c));
      }
      env[key] = body;
      continue;
    }
    value = value.replace(/\s+#.*$/, '').trim();
    env[key] = expand(value);
  }
  return env;
}

function closingQuoteIndex(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (body[i] === quote) {
      return i;
    }
  }
  return -1;
}

function hasClosingQuote(body: string, quote: string): boolean {
  return closingQuoteIndex(body, quote) >= 0;
}

/** The default connection as Laravel's stock config/database.php derives it from `.env`. */
export function fromEnv(env: Record<string, string>): {
  defaultConnection: string;
  raw: Record<string, Raw>;
  migrations: unknown;
} {
  const name = env.DB_CONNECTION || 'mysql';
  const driver = asDriver(name) ?? (env.DB_URL ? undefined : 'mysql');
  const raw: Raw = {
    driver: driver ?? name,
    url: env.DB_URL || env.DATABASE_URL,
    host: env.DB_HOST || '127.0.0.1',
    port: env.DB_PORT,
    database: env.DB_DATABASE || (driver === 'sqlite' ? 'database/database.sqlite' : 'laravel'),
    username: env.DB_USERNAME || (driver === 'pgsql' ? 'root' : 'root'),
    password: env.DB_PASSWORD ?? '',
    unix_socket: env.DB_SOCKET,
    search_path: env.DB_SEARCH_PATH || env.DB_SCHEMA,
    prefix: env.DB_PREFIX,
  };
  return { defaultConnection: name, raw: { [name]: raw }, migrations: undefined };
}
