import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { fromEnv, normalizeConnection, parseDatabaseUrl, parseEnv, parsePhpOutput } from '../src/db/config.ts';
import { socketFor } from '../src/db/drivers/mysql.ts';
import { SchemaIndex, SchemaStore } from '../src/db/schema.ts';
import type { ConnectionSchema } from '../src/db/types.ts';
import { plural, tableForForeignKey, tableForModel } from '../src/laravel/inflector.ts';
import { parseSettings } from '../src/settings.ts';
import { columnKey, UsageStore } from '../src/usage.ts';
import { fakeDrivers, TABLES, table } from './helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-query-unit-'));

describe('inflector', () => {
  test('model class → table, like Eloquent', () => {
    const cases: Record<string, string> = {
      'App\\Models\\User': 'users',
      UserProfile: 'user_profiles',
      Person: 'people',
      Category: 'categories',
      Status: 'statuses',
      Address: 'addresses',
      Child: 'children',
      Box: 'boxes',
      Equipment: 'equipment',
      OOWList: 'o_o_w_lists',
      Data: 'data',
      Wife: 'wives',
      Analysis: 'analyses',
    };
    for (const [model, expected] of Object.entries(cases)) {
      assert.equal(tableForModel(model), expected, model);
    }
    assert.equal(plural('Mouse'), 'Mice');
    assert.equal(tableForForeignKey('parent_category_id'), 'parent_categories');
  });
});

describe('settings', () => {
  test('defaults and nested section', () => {
    const settings = parseSettings({
      'laravel-query': { diagnostics: { severity: 'error' }, completion: { maxItems: 5 } },
    });
    assert.equal(settings.diagnostics.severity, 'error');
    assert.equal(settings.completion.maxItems, 400, 'below the minimum: default');
    assert.equal(settings.discovery, 'auto');
    assert.deepEqual(settings.php, ['php']);
  });

  test('connections: overrides and removals', () => {
    const settings = parseSettings({ connections: { a: { host: 'db', port: '3307', databases: ['x', 1] }, b: false } });
    assert.deepEqual(settings.connections.a, { host: 'db', port: 3307, databases: ['x'] });
    assert.equal(settings.connections.b, false);
  });
});

describe('connection discovery', () => {
  test('.env syntax', () => {
    const env = parseEnv(`# comment
APP_NAME="My App"
export DB_HOST=db.local # inline comment
DB_PASSWORD='p#ss word'
DB_DATABASE=\${APP_SLUG}_db
APP_SLUG=ignored
MULTI="line1
line2"
`);
    assert.equal(env.APP_NAME, 'My App');
    assert.equal(env.DB_HOST, 'db.local');
    assert.equal(env.DB_PASSWORD, 'p#ss word');
    assert.equal(env.DB_DATABASE, '_db');
    assert.equal(env.MULTI, 'line1\nline2');
  });

  test('default connection from .env', () => {
    const { defaultConnection, raw } = fromEnv({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'shop', DB_USERNAME: 'u' });
    assert.equal(defaultConnection, 'pgsql');
    const config = normalizeConnection('pgsql', raw.pgsql, '/app', 'env');
    assert.equal(config?.driver, 'pgsql');
    assert.equal(config?.port, 5432);
    assert.equal(config?.database, 'shop');
  });

  test('Laravel connection arrays: url, read/write, sqlite path, search_path, prefix', () => {
    const fromUrl = normalizeConnection(
      'm',
      { driver: 'mysql', url: 'mariadb://u:p%40ss@h:3307/db?charset=utf8' },
      '/app',
      'php',
    );
    assert.equal(fromUrl?.driver, 'mariadb');
    assert.equal(fromUrl?.password, 'p@ss');
    assert.equal(fromUrl?.port, 3307);
    const split = normalizeConnection(
      'm',
      { driver: 'mysql', write: { host: ['w1', 'w2'] }, database: 'd' },
      '/app',
      'php',
    );
    assert.equal(split?.host, 'w1');
    const sqlite = normalizeConnection('s', { driver: 'sqlite', database: 'database/db.sqlite' }, '/app', 'php');
    assert.equal(sqlite?.database, path.join('/app', 'database/db.sqlite'));
    const pg = normalizeConnection(
      'p',
      { driver: 'pgsql', search_path: 'tenant, public', prefix: 'x_' },
      '/app',
      'php',
    );
    assert.deepEqual(pg?.searchPath, ['tenant', 'public']);
    assert.equal(pg?.prefix, 'x_');
    assert.equal(normalizeConnection('x', { driver: 'sqlsrv' }, '/app', 'php'), undefined);
    assert.equal(parseDatabaseUrl('postgresql://h/db').driver, 'pgsql');
  });

  test('PHP output: noise around the markers is ignored', () => {
    const out = parsePhpOutput(
      'Deprecated: something\n__LARAVEL_QUERY__{"default":"mysql","connections":{"mysql":{"driver":"mysql"}},"migrations":{"table":"migs"}}__LARAVEL_QUERY__\n',
    );
    assert.equal(out.defaultConnection, 'mysql');
    assert.deepEqual(Object.keys(out.raw), ['mysql']);
  });

  test('localhost goes through the default socket, like PDO', () => {
    const exists = (file: string) => file === '/var/run/mysqld/mysqld.sock';
    assert.equal(socketFor({ name: 'a', driver: 'mysql', host: 'localhost' }, exists), '/var/run/mysqld/mysqld.sock');
    assert.equal(socketFor({ name: 'a', driver: 'mysql', host: '127.0.0.1' }, exists), undefined);
    assert.equal(socketFor({ name: 'a', driver: 'mysql', host: 'localhost', socket: '/s' }, exists), '/s');
  });
});

function schema(tables = TABLES, extra: Partial<ConnectionSchema> = {}): ConnectionSchema {
  return {
    connection: 'mysql',
    driver: 'mysql',
    defaultNamespaces: ['app'],
    namespaces: ['app'],
    tables,
    loadedAt: 0,
    duration: 0,
    fingerprint: 'f',
    ...extra,
  };
}

describe('schema index', () => {
  test('finds tables case-insensitively on MySQL, exactly on PostgreSQL', () => {
    const mysql = new SchemaIndex(schema());
    assert.equal(mysql.findTable('USERS')?.name, 'users');
    assert.equal(mysql.findTable('app.posts')?.name, 'posts');
    assert.equal(mysql.findTable('nope'), undefined);
    const pg = new SchemaIndex(
      schema([table('Users', ['id'], { namespace: 'public' })], {
        driver: 'pgsql',
        defaultNamespaces: ['public'],
        namespaces: ['public'],
      }),
    );
    assert.equal(pg.findTable('users'), undefined);
    assert.equal(pg.findTable('Users')?.name, 'Users');
    assert.equal(pg.findTable('public.Users')?.name, 'Users');
  });

  test('references are bare in the default namespace', () => {
    const index = new SchemaIndex(
      schema([...TABLES, table('audit', ['id'], { namespace: 'logs' })], { namespaces: ['app', 'logs'] }),
    );
    assert.equal(index.reference(index.findTable('users') as never), 'users');
    assert.equal(index.reference(index.findTable('logs.audit') as never), 'logs.audit');
  });
});

describe('schema store', () => {
  test('reads once for concurrent requests, strips the prefix, caches on disk', async () => {
    const dir = tmp();
    const calls: string[] = [];
    const store = new SchemaStore({ cacheDir: dir, drivers: fakeDrivers(calls), log: () => undefined });
    store.setConnections([{ name: 'mysql', driver: 'mysql', database: 'app', prefix: 'role_' }], 'mysql');
    const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
    assert.equal(a, b);
    assert.deepEqual(calls, ['mysql']);
    assert.deepEqual(
      a?.defaultTables().map((t) => t.name),
      ['user'],
      'only prefixed tables, without the prefix',
    );

    const again = new SchemaStore({ cacheDir: dir, drivers: fakeDrivers(calls), log: () => undefined });
    again.setConnections([{ name: 'mysql', driver: 'mysql', database: 'app', prefix: 'role_' }], 'mysql');
    assert.ok(again.get(), 'served from the cache without reading');
    assert.equal(calls.length, 1);

    const otherDb = new SchemaStore({ cacheDir: dir, drivers: fakeDrivers(calls), log: () => undefined });
    otherDb.setConnections([{ name: 'mysql', driver: 'mysql', database: 'other' }], 'mysql');
    assert.equal(otherDb.get(), undefined, 'a cache of another database is not used');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a failing connection keeps the cached schema and reports the error', async () => {
    const store = new SchemaStore({
      cacheDir: tmp(),
      drivers: { mysql: async () => ({ introspect: async () => Promise.reject(new Error('refused')) }) },
      log: () => undefined,
    });
    store.setConnections([{ name: 'mysql', driver: 'mysql', database: 'app' }], 'mysql');
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.state()?.error, 'refused');
  });

  test('a changed migrations table re-reads the schema', async () => {
    const calls: string[] = [];
    let marker = '1';
    const drivers = fakeDrivers(calls);
    const base = await drivers.mysql();
    const store = new SchemaStore({
      cacheDir: tmp(),
      drivers: { mysql: async () => ({ ...base, migrationsMarker: async () => marker }) },
      log: () => undefined,
    });
    store.setConnections([{ name: 'mysql', driver: 'mysql', database: 'app' }], 'mysql');
    await store.refresh();
    await store.checkMigrations();
    assert.equal(calls.length, 1);
    marker = '2';
    await store.checkMigrations();
    assert.equal(calls.length, 2);
  });
});

describe('usage statistics', () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 21);

  test('frecency ranks recent picks above old ones', () => {
    const usage = new UsageStore(undefined, 14);
    const old = columnKey('m', 'app', 'users', 'name');
    const recent = columnKey('m', 'app', 'users', 'email');
    for (let i = 0; i < 5; i++) {
      usage.record(old, now - 60 * DAY);
    }
    usage.record(recent, now - DAY);
    usage.record(recent, now);
    assert.ok(usage.score(recent, now) > usage.score(old, now));
    assert.equal(usage.rank(recent, now), 1);
    assert.equal(usage.count(old), 5);
  });

  test('trend: rising, falling, steady', () => {
    const usage = new UsageStore(undefined, 14);
    const a = 'c:m:app.t.a';
    const b = 'c:m:app.t.b';
    const c = 'c:m:app.t.c';
    // A week ago: a > b. Since then b got picked a lot, a nothing.
    for (let i = 0; i < 4; i++) {
      usage.record(a, now - 20 * DAY);
    }
    usage.record(b, now - 20 * DAY);
    for (let i = 0; i < 6; i++) {
      usage.record(b, now - DAY);
    }
    usage.record(c, now - DAY);
    assert.equal(usage.trend(b, now), 'up');
    assert.equal(usage.trend(a, now), 'down');
    assert.equal(usage.trend(c, now), 'up', 'new entries rise');
    assert.equal(usage.trend('c:m:app.t.none', now), undefined);
  });

  test('reset one, by prefix, all; persisted to disk', () => {
    const dir = tmp();
    const file = path.join(dir, 'usage.json');
    const usage = new UsageStore(file, 14);
    usage.record('c:m:app.users.a');
    usage.record('c:m:app.users.b');
    usage.record('c:m:app.posts.c');
    usage.flush();
    const loaded = new UsageStore(file, 14);
    assert.equal(loaded.size, 3);
    assert.equal(loaded.reset('c:m:app.users.a'), 1);
    assert.equal(loaded.reset('c:m:app.users.*'), 1);
    assert.equal(loaded.reset(), 1);
    assert.equal(loaded.size, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
