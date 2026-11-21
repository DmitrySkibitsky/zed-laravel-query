/**
 * One Laravel project (workspace folder): settings, the application on disk, the schemas of its
 * connections and the usage statistics. Startup never waits for the database: connections and
 * schemas of the previous session come from the cache, discovery and refresh run in background.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type DiscoveredConnections, discoverConnections } from './db/config.ts';
import { defaultCacheBase, projectCacheDir, SchemaStore } from './db/schema.ts';
import type { ConnectionConfig, DriverModule } from './db/types.ts';
import { LaravelProject } from './laravel/project.ts';
import type { Settings } from './settings.ts';
import { UsageStore } from './usage.ts';

export const DRIVERS: Record<string, () => Promise<DriverModule>> = {
  mysql: () => import('./db/drivers/mysql.ts'),
  mariadb: () => import('./db/drivers/mysql.ts'),
  pgsql: () => import('./db/drivers/pgsql.ts'),
  sqlite: () => import('./db/drivers/sqlite.ts'),
};

export interface WorkspaceOptions {
  log: (message: string) => void;
  /** A connection's schema changed: re-run diagnostics. */
  onSchemaChange?: (connection: string) => void;
  drivers?: Record<string, () => Promise<DriverModule>>;
}

export class Workspace {
  readonly root: string;
  settings: Settings;
  readonly project: LaravelProject;
  readonly store: SchemaStore;
  readonly usage: UsageStore;
  readonly cacheDir: string;
  discovered: DiscoveredConnections | undefined;
  /** Resolves once connections are discovered and the eager schemas are read. */
  ready: Promise<void>;
  private readonly options: WorkspaceOptions;

  constructor(root: string, settings: Settings, options: WorkspaceOptions) {
    this.root = root;
    this.settings = settings;
    this.options = options;
    this.cacheDir = projectCacheDir(settings.cacheDirectory ?? defaultCacheBase(), root);
    this.project = new LaravelProject(root, settings.migrationPaths, settings.metaFiles);
    this.store = new SchemaStore({
      cacheDir: this.cacheDir,
      drivers: options.drivers ?? DRIVERS,
      log: options.log,
      onChange: (connection) => options.onSchemaChange?.(connection),
    });
    this.usage = new UsageStore(path.join(this.cacheDir, 'usage.json'), settings.usage.halfLifeDays, options.log);
    this.restoreConnections();
    this.ready = this.start();
  }

  /** Connections of the last session (no passwords): cached schemas are served right away. */
  private restoreConnections(): void {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.cacheDir, 'connections.json'), 'utf8')) as {
        defaultConnection: string;
        connections: ConnectionConfig[];
      };
      this.store.setConnections(data.connections, data.defaultConnection);
    } catch {
      // First start in this project.
    }
  }

  private saveConnections(): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const connections = (this.discovered?.connections ?? []).map(({ password: _password, ...rest }) => rest);
      fs.writeFileSync(
        path.join(this.cacheDir, 'connections.json'),
        JSON.stringify({ defaultConnection: this.store.defaultConnection, connections }),
      );
    } catch {
      // The cache is an optimisation only.
    }
  }

  private async start(): Promise<void> {
    await this.discover();
    const eager = new Set([
      this.store.defaultConnection,
      ...this.settings.eagerConnections,
      ...Object.keys(this.settings.connections),
    ]);
    const reads: Array<Promise<unknown>> = [];
    for (const name of eager) {
      const state = this.store.state(name);
      if (!state) {
        continue;
      }
      if (!state.index || this.settings.refreshOnStartup) {
        reads.push(this.store.refresh(name));
      }
    }
    await Promise.all(reads);
    this.store.watch(this.settings.watchMigrations);
  }

  async discover(): Promise<void> {
    this.discovered = await discoverConnections(this.root, this.settings, this.options.log);
    this.store.setConnections(this.discovered.connections, this.discovered.defaultConnection);
    this.store.migrationsTable = this.discovered.migrationsTable;
    this.saveConnections();
    const names = this.discovered.connections.map((c) => `${c.name} (${c.driver})`).join(', ') || 'none';
    this.options.log(
      `laravel-query: ${this.root}: connections from ${this.discovered.source}: ${names}; default ${this.store.defaultConnection || '-'}`,
    );
  }

  updateSettings(settings: Settings): void {
    const rediscover =
      JSON.stringify([settings.connections, settings.discovery, settings.php, settings.defaultConnection]) !==
      JSON.stringify([
        this.settings.connections,
        this.settings.discovery,
        this.settings.php,
        this.settings.defaultConnection,
      ]);
    this.settings = settings;
    this.usage.setHalfLife(settings.usage.halfLifeDays);
    this.project.setMigrationPaths(settings.migrationPaths);
    this.project.setMetaPaths(settings.metaFiles);
    this.store.watch(settings.watchMigrations);
    if (rediscover) {
      this.ready = this.start();
    }
  }

  /** Re-reads connections (config may have changed) and the given or all loaded schemas. */
  async refresh(connection?: string): Promise<string> {
    await this.discover();
    const names = connection
      ? [connection]
      : [...new Set([this.store.defaultConnection, ...this.store.loaded().map((index) => index.connection)])];
    const results: string[] = [];
    for (const name of names.filter(Boolean)) {
      const index = await this.store.refresh(name);
      const state = this.store.state(name);
      if (state?.error) {
        results.push(`${name}: ${state.error}`);
      } else if (index) {
        results.push(
          `${name}: ${index.schema.tables.length} tables, ${index.columnCount} columns (${index.schema.duration} ms)`,
        );
      }
    }
    return results.join('; ') || 'no connections';
  }

  status(): string {
    const lines = [`Laravel Query — ${this.root}`];
    lines.push(
      `connections from ${this.discovered?.source ?? 'cache'}; default: ${this.store.defaultConnection || '-'}`,
    );
    for (const name of this.store.connectionNames()) {
      const state = this.store.state(name);
      const config = state?.config;
      const where =
        config?.driver === 'sqlite'
          ? config.database
          : `${config?.host ?? ''}:${config?.port ?? ''}/${config?.database ?? ''}`;
      const schema = state?.index
        ? `${state.index.schema.tables.length} tables, ${state.index.columnCount} columns, read ${new Date(state.index.schema.loadedAt).toLocaleString()}`
        : state?.loading
          ? 'loading…'
          : 'not loaded (loads on first use)';
      lines.push(`• ${name} [${config?.driver}] ${where}: ${schema}${state?.error ? ` — error: ${state.error}` : ''}`);
    }
    for (const warning of this.discovered?.warnings ?? []) {
      lines.push(`! ${warning}`);
    }
    lines.push(`usage statistics: ${this.usage.size} items; cache: ${this.cacheDir}`);
    return lines.join('\n');
  }

  dispose(): void {
    this.store.dispose();
    this.usage.flush();
  }
}
