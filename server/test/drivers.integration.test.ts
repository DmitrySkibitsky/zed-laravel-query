/**
 * The drivers against real servers. Each suite runs when its URL is set, e.g.:
 *
 *   LQ_TEST_MYSQL=mysql://root:root@127.0.0.1:3306
 *   LQ_TEST_MARIADB=mariadb://root:root@127.0.0.1:3307
 *   LQ_TEST_PGSQL=postgres://postgres:postgres@127.0.0.1:5432/postgres
 *
 * A throwaway database (schema on PostgreSQL) is created and dropped around the suite. CI runs
 * all three as service containers.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { normalizeConnection, parseDatabaseUrl } from '../src/db/config.ts';
import * as mysqlDriver from '../src/db/drivers/mysql.ts';
import * as pgsqlDriver from '../src/db/drivers/pgsql.ts';
import type { ConnectionConfig, IntrospectionResult } from '../src/db/types.ts';

const suffix = `${process.pid}_${Date.now() % 100000}`;

function config(url: string, overrides: Partial<ConnectionConfig>): ConnectionConfig {
  const raw = parseDatabaseUrl(url);
  const normalized = normalizeConnection('test', raw, '/', 'settings');
  assert.ok(normalized);
  return { ...normalized, ...overrides };
}

function checkSchema(result: IntrospectionResult, ns: string) {
  const users = result.tables.find((t) => t.name === 'users' && t.namespace === ns);
  assert.ok(users, 'users table');
  assert.deepEqual(
    users.columns.map((c) => c.name),
    ['id', 'email', 'nickname', 'created_at'],
  );
  assert.equal(users.columns[0].key, 'PRI');
  assert.equal(users.columns[1].key, 'UNI');
  assert.equal(users.columns[2].nullable, true);
  assert.equal(users.columns[1].nullable, false);
  assert.match(users.columns[1].type, /varchar\(120\)|character varying\(120\)/);
  assert.ok(users.indexes.some((i) => i.unique && i.columns.join() === 'email'));
  const posts = result.tables.find((t) => t.name === 'posts' && t.namespace === ns);
  assert.ok(posts);
  assert.deepEqual(
    posts.foreignKeys.map((fk) => [fk.columns.join(), fk.foreignTable, fk.foreignColumns.join()]),
    [['user_id', 'users', 'id']],
  );
  const view = result.tables.find((t) => t.name === 'active_users');
  assert.equal(view?.kind, 'view');
}

for (const [label, variable] of [
  ['MySQL', 'LQ_TEST_MYSQL'],
  ['MariaDB', 'LQ_TEST_MARIADB'],
] as const) {
  const url = process.env[variable];
  describe(`${label} driver`, { skip: url ? false : `${variable} is not set` }, () => {
    const db = `lq_test_${suffix}`;
    const other = `lq_test_${suffix}_logs`;
    let admin: mysql.Connection;

    before(async () => {
      const c = config(url as string, {});
      admin = await mysql.createConnection({
        host: c.host,
        port: c.port,
        user: c.username,
        password: c.password,
        multipleStatements: true,
      });
      await admin.query(`
        CREATE DATABASE ${db}; CREATE DATABASE ${other};
        CREATE TABLE ${db}.users (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(120) NOT NULL UNIQUE, nickname VARCHAR(50) NULL COMMENT 'shown name', created_at TIMESTAMP NULL);
        CREATE TABLE ${db}.posts (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, title VARCHAR(255), CONSTRAINT posts_user_id_foreign FOREIGN KEY (user_id) REFERENCES ${db}.users (id));
        CREATE VIEW ${db}.active_users AS SELECT id, email FROM ${db}.users;
        CREATE TABLE ${db}.migrations (id INT AUTO_INCREMENT PRIMARY KEY, migration VARCHAR(255), batch INT);
        CREATE TABLE ${other}.audit (id INT PRIMARY KEY, action VARCHAR(20));
      `);
    });

    after(async () => {
      await admin?.query(`DROP DATABASE IF EXISTS ${db}; DROP DATABASE IF EXISTS ${other};`);
      await admin?.end();
    });

    test('tables, columns, keys, indexes, foreign keys, views; extra databases', async () => {
      const result = await mysqlDriver.introspect(config(url as string, { database: db, databases: [other] }));
      checkSchema(result, db);
      assert.deepEqual(result.defaultNamespaces, [db]);
      assert.ok(result.tables.some((t) => t.namespace === other && t.name === 'audit'));
      const users = result.tables.find((t) => t.name === 'users');
      assert.equal(users?.columns[2].comment, 'shown name');
      assert.equal(users?.columns[0].extra, 'auto_increment');
    });

    test('migrations marker changes after a migration', async () => {
      const c = config(url as string, { database: db });
      const before = await mysqlDriver.migrationsMarker(c, 'migrations');
      await admin.query(`INSERT INTO ${db}.migrations (migration, batch) VALUES ('x', 1)`);
      assert.notEqual(await mysqlDriver.migrationsMarker(c, 'migrations'), before);
    });
  });
}

const pgUrl = process.env.LQ_TEST_PGSQL;
describe('PostgreSQL driver', { skip: pgUrl ? false : 'LQ_TEST_PGSQL is not set' }, () => {
  const schema = `lq_test_${suffix}`;
  let admin: pg.Client;

  before(async () => {
    const c = config(pgUrl as string, {});
    admin = new pg.Client({ host: c.host, port: c.port, user: c.username, password: c.password, database: c.database });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.users (id BIGSERIAL PRIMARY KEY, email VARCHAR(120) NOT NULL UNIQUE, nickname VARCHAR(50) NULL, created_at TIMESTAMP NULL);
      COMMENT ON COLUMN ${schema}.users.nickname IS 'shown name';
      CREATE TABLE ${schema}.posts (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES ${schema}.users (id), title VARCHAR(255));
      CREATE VIEW ${schema}.active_users AS SELECT id, email FROM ${schema}.users;
      CREATE TABLE ${schema}.migrations (id SERIAL PRIMARY KEY, migration VARCHAR(255), batch INT);
    `);
  });

  after(async () => {
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  test('tables, columns, keys, indexes, foreign keys, views; search_path', async () => {
    const result = await pgsqlDriver.introspect(config(pgUrl as string, { searchPath: [schema, 'public'] }));
    checkSchema(result, schema);
    assert.equal(result.defaultNamespaces[0], schema);
    const users = result.tables.find((t) => t.name === 'users' && t.namespace === schema);
    assert.equal(users?.columns[2].comment, 'shown name');
    assert.equal(users?.columns[0].extra, 'auto_increment');
  });

  test('migrations marker changes after a migration', async () => {
    const c = config(pgUrl as string, { searchPath: [schema] });
    const before = await pgsqlDriver.migrationsMarker(c, 'migrations');
    assert.ok(before);
    await admin.query(`INSERT INTO ${schema}.migrations (migration, batch) VALUES ('x', 1)`);
    assert.notEqual(await pgsqlDriver.migrationsMarker(c, 'migrations'), before);
  });
});
