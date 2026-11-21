/**
 * End-to-end: the bundled server (dist/laravel-query-server.cjs — the release asset) over stdio,
 * with a generated Laravel project whose `.env` points at a real SQLite database. Run
 * `npm run build` first (`npm test` does).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { URI } from 'vscode-uri';
import { createProject, type FixtureProject, php } from './helpers.ts';
import { LspClient } from './lspClient.ts';

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/laravel-query-server.cjs');

type Sqlite = { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } };
const sqlite = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
  | Sqlite
  | undefined;

const SOURCE = php(`return DB::table('users')
            ->join('posts', 'posts.user_id', '=', 'users.id')
            ->where('posts.titel', 'x')
            ->where('em', 1)
            ->get();`);

describe('bundled server over stdio (SQLite)', { skip: sqlite ? false : 'node:sqlite is not available' }, () => {
  let fixture: FixtureProject;
  let client: LspClient;
  let uri: string;
  let capabilities: Record<string, any>;
  const at = (needle: string, delta = 0) => {
    const offset = SOURCE.indexOf(needle) + delta;
    const lines = SOURCE.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
  };
  const complete = (needle: string, delta: number) =>
    client.request('textDocument/completion', { textDocument: { uri }, position: at(needle, delta) });

  before(async () => {
    assert.ok(fs.existsSync(BUNDLE), `missing ${BUNDLE}: run npm run build`);
    fixture = createProject({
      '.env': 'APP_NAME=Test\nDB_CONNECTION=sqlite\nDB_DATABASE=database/database.sqlite\n',
    });
    const db = new (sqlite as Sqlite).DatabaseSync(path.join(fixture.root, 'database', 'database.sqlite'));
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT);
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, migration TEXT, batch INTEGER);
    `);
    db.close();
    const file = fixture.write('app/Http/Controllers/TestController.php', SOURCE);
    uri = URI.file(file).toString();
    client = new LspClient(process.execPath, [BUNDLE, '--stdio']);
    const result = await client.request('initialize', {
      processId: process.pid,
      rootUri: URI.file(fixture.root).toString(),
      workspaceFolders: [{ uri: URI.file(fixture.root).toString(), name: 'fixture' }],
      capabilities: {
        textDocument: {
          completion: {
            completionItem: { snippetSupport: true, insertReplaceSupport: true },
            completionList: { itemDefaults: ['editRange', 'data'] },
          },
          hover: { contentFormat: ['markdown'] },
        },
      },
      initializationOptions: { cacheDirectory: path.join(fixture.root, '.cache'), watchMigrations: 0 },
    });
    assert.equal(result.serverInfo.name, 'laravel-query');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(BUNDLE), '../package.json'), 'utf8'));
    assert.equal(result.serverInfo.version, pkg.version, 'bundle reports the package version');
    capabilities = result.capabilities;
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: 1, text: SOURCE } });
    // The schema is read in the background: wait for the first non-empty answer.
    for (let i = 0; i < 100; i++) {
      const list = await complete("->where('em", 11);
      if (list?.items?.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  after(async () => {
    try {
      assert.equal(await client.shutdown(), 0);
    } finally {
      client.kill();
      fixture.cleanup();
    }
  });

  test('capabilities', () => {
    assert.deepEqual(capabilities.completionProvider.triggerCharacters, ["'", '"', '.', ',', ':', '|']);
    assert.ok(capabilities.executeCommandProvider.commands.includes('laravelQuery.recordUsage'));
    assert.ok(capabilities.hoverProvider && capabilities.definitionProvider && capabilities.codeActionProvider);
  });

  test('columns of the query tables, the joined one too', async () => {
    const list = await complete("->where('em", 11);
    const labels = list.items.map((i: { label: string }) => i.label);
    assert.ok(labels.includes('email'));
    assert.ok(labels.includes('title'));
    assert.ok(labels.includes('posts.user_id'));
    assert.ok(list.itemDefaults.editRange.insert, 'edit range sent once');
    assert.equal(list.isIncomplete, true);
  });

  test('tables', async () => {
    const list = await complete("DB::table('users", 11);
    assert.deepEqual(list.items.map((i: { label: string }) => i.label).sort(), ['migrations', 'posts', 'users']);
  });

  test('hover', async () => {
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: at("'posts.user_id'", 8),
    });
    assert.match(hover.contents.value, /\*\*posts\.user_id\*\* `integer`/);
    assert.match(hover.contents.value, /→ `users\.id`/);
  });

  test('diagnostics are published for unknown columns', async () => {
    for (
      let i = 0;
      i < 100 &&
      !client.notifications.some((n) => n.method === 'textDocument/publishDiagnostics' && n.params.diagnostics.length);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const published = client.notifications.filter(
      (n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri,
    );
    const messages = published[published.length - 1].params.diagnostics.map((d: { message: string }) => d.message);
    assert.deepEqual(messages, ["Unknown column 'posts.titel' in 'posts'", "Unknown column 'em' in users, posts"]);
  });

  test('picking an item records usage; reset and refresh commands', async () => {
    const list = await complete("->where('em", 11);
    const item = list.items.find((i: { label: string }) => i.label === 'name');
    await client.request('workspace/executeCommand', item.command);
    const ranked = await complete("->where('em", 11);
    const name = ranked.items.find((i: { label: string }) => i.label === 'name');
    assert.match(name.sortText, /^a0/);
    assert.match(name.detail, /^▲ /);
    assert.ok(ranked.items.some((i: { label: string }) => i.label === '↺ reset rank: name'));
    await client.request('workspace/executeCommand', { command: 'laravelQuery.resetUsage', arguments: [] });
    const reset = await complete("->where('em", 11);
    assert.doesNotMatch(reset.items.find((i: { label: string }) => i.label === 'name').sortText, /^a0/);
    await client.request('workspace/executeCommand', { command: 'laravelQuery.refreshSchema', arguments: [] });
    const message = client.notifications.find(
      (n) => n.method === 'window/showMessage' && /schema refreshed/.test(n.params.message),
    );
    assert.match(message?.params.message ?? '', /sqlite: 3 tables, 9 columns/);
  });

  test('code actions on query strings', async () => {
    const actions = await client.request('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: at("'em", 2), end: at("'em", 2) },
      context: { diagnostics: [] },
    });
    assert.ok(actions.some((a: { title: string }) => a.title === 'Laravel Query: refresh database schema'));
  });

  test('the schema cache lets a restarted server answer without waiting', async () => {
    const second = new LspClient(process.execPath, [BUNDLE, '--stdio']);
    try {
      await second.request('initialize', {
        processId: process.pid,
        rootUri: URI.file(fixture.root).toString(),
        workspaceFolders: [{ uri: URI.file(fixture.root).toString(), name: 'fixture' }],
        capabilities: {},
        initializationOptions: {
          cacheDirectory: path.join(fixture.root, '.cache'),
          watchMigrations: 0,
          refreshOnStartup: false,
        },
      });
      second.notify('initialized', {});
      second.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: 1, text: SOURCE } });
      const list = await second.request('textDocument/completion', {
        textDocument: { uri },
        position: at("->where('em", 11),
      });
      assert.ok(list.items.some((i: { label: string }) => i.label === 'email'));
      assert.equal(await second.shutdown(), 0);
    } finally {
      second.kill();
    }
  });
});
