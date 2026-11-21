import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHarness, type Harness, php } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(() => h.cleanup());

const diagnostics = (body: string) => {
  // A trailing cursor marker keeps `|` in rule strings as code.
  const { document } = h.document(`${php(body)}‸`);
  return h.service.diagnostics(document, h.workspace).map((d) => d.message);
};

describe('diagnostics', () => {
  test('unknown tables and columns', () => {
    assert.deepEqual(diagnostics(`DB::table('userz')->get();`), ["Unknown table 'userz' (connection mysql)"]);
    assert.deepEqual(diagnostics(`DB::table('users')->where('nmae', 1);`), ["Unknown column 'nmae' in users"]);
    assert.deepEqual(diagnostics(`User::where('posts.titel', 1);`), ["Unknown column 'posts.titel' in 'posts'"]);
    assert.deepEqual(diagnostics(`DB::table('users as u')->where('u.mail', 1);`), ["Unknown column 'u.mail' in 'u'"]);
  });

  test('valid queries are clean', () => {
    assert.deepEqual(
      diagnostics(`DB::table('users as u')
            ->join('posts as p', function ($join) { $join->on('p.user_id', '=', 'u.id'); })
            ->select('u.name as author', 'p.*', DB::raw('count(*) as total'))
            ->where('p.title', 'like', 'x%')
            ->whereNotNull('u.email')
            ->orderBy('author')
            ->orderBy('total')
            ->get();`),
      [],
    );
    assert.deepEqual(diagnostics(`User::withCount('posts')->orderBy('posts_count')->get();`), []);
    assert.deepEqual(diagnostics(`User::where('meta->theme', 'dark');`).length, 1, 'JSON path base column checked');
    assert.deepEqual(diagnostics(`User::where('email->theme', 'dark');`), []);
  });

  test('qualified columns of known tables are checked in queries of unresolved roots', () => {
    const root = `app_helper('job')->grid()->newQuery()`;
    assert.deepEqual(diagnostics(`${root}->select(['users.nmae']);`), ["Unknown column 'users.nmae' in 'users'"]);
    assert.deepEqual(diagnostics(`${root}->select(['users.']);`), ["Column name missing after 'users.'"]);
    assert.deepEqual(diagnostics(`${root}->select(['users.email', 'whatever']);`), [], 'bare columns are not checked');
    assert.deepEqual(diagnostics(`${root}->join('posts as p', 'p.user_id', '=', 'users.id')->where('p.nope', 1);`), [
      "Unknown column 'p.nope' in 'p'",
    ]);
    assert.deepEqual(diagnostics(`${root}->where('x.anything', 1);`), [], 'unknown qualifier: maybe a raw SQL alias');
    assert.deepEqual(diagnostics(`app(User::class)->newQuery()->select(['users.']);`), [
      "Column name missing after 'users.'",
    ]);
    assert.deepEqual(diagnostics(`app(User::class)->newQuery()->select(['nope']);`), [
      "Unknown column 'nope' in users",
    ]);
  });

  test('validation rules: table and column checked separately', () => {
    assert.deepEqual(
      diagnostics(`$r = ['post_id' => ['required', 'exists:posts,id'], 'e' => 'unique:users,email,1,id'];`),
      [],
    );
    assert.deepEqual(diagnostics(`$r = ['post_id' => 'required|exists:postz,id'];`), [
      "Unknown table 'postz' (connection mysql)",
    ]);
    assert.deepEqual(diagnostics(`$r = ['post_id' => 'exists:posts,nope|required'];`), [
      "Unknown column 'nope' in posts",
    ]);
    assert.deepEqual(
      diagnostics(`$r = ['user_id' => [Rule::exists('users', 'id')->whereNotNull('email_verified')]];`),
      ["Unknown column 'email_verified' in users"],
    );
  });

  test('models found by convention: only qualified columns are checked', () => {
    const check = (body: string) => {
      const { document } = h.document(`<?php\nuse Acme\\Missing\\Models\\Comment;\n${body}`);
      return h.service.diagnostics(document, h.workspace).map((d) => d.message);
    };
    assert.deepEqual(check(`Comment::where('whatever', 1);`), []);
    assert.deepEqual(check(`Comment::where('comments.nope', 1);`), ["Unknown column 'comments.nope' in 'comments'"]);
  });

  test('no guesses: subquery aliases, inferred queries, unknown relations, other databases', () => {
    assert.deepEqual(
      diagnostics(
        `DB::table('users')->joinSub($sub, 'latest', 'latest.user_id', '=', 'users.id')->where('latest.anything', 1);`,
      ),
      [],
    );
    assert.deepEqual(diagnostics(`$this->grid()->join('posts', 'a', '=', 'b')->where('whatever', 1);`), []);
    assert.deepEqual(diagnostics(`User::whereHas('unknownRelation', fn ($q) => $q->where('whatever', 1));`), []);
    assert.deepEqual(diagnostics(`DB::table('otherdb.table')->get();`), []);
    assert.deepEqual(diagnostics(`collect($rows)->where('whatever', 1);`), []);
  });

  test('can be disabled', async () => {
    const off = await createHarness({ diagnostics: { enabled: false } });
    try {
      const { document } = off.document(php(`DB::table('userz')->get();`));
      assert.deepEqual(off.service.diagnostics(document, off.workspace), []);
    } finally {
      off.cleanup();
    }
  });
});

describe('hover', () => {
  test('column and table details', () => {
    const { document, offset } = h.document(php(`DB::table('users')->where('em|ail', 1);`));
    const hover = h.service.hover(document, document.positionAt(offset), h.workspace);
    assert.ok(hover);
    const value = (hover.contents as { value: string }).value;
    assert.match(value, /\*\*users\.email\*\* `varchar\(255\)`/);
    assert.match(value, /not null/);
    const table = h.document(php(`DB::table('us|ers');`));
    const tableHover = h.service.hover(table.document, table.document.positionAt(table.offset), h.workspace);
    assert.ok(tableHover);
    assert.match(
      (tableHover.contents as { value: string }).value,
      /\*\*users\*\*[\s\S]*Model: `App\\Models\\User`[\s\S]*email varchar\(255\)/,
    );
  });
});

describe('definition', () => {
  test('table → model and migration; column → migration line', () => {
    const table = h.document(php(`DB::table('us|ers');`));
    const locations = h.service.definition(table.document, table.document.positionAt(table.offset), h.workspace) ?? [];
    assert.ok(locations.some((l) => l.uri.endsWith('app/Models/User.php')));
    assert.ok(locations.some((l) => l.uri.endsWith('create_users_table.php')));
    const column = h.document(php(`User::where('em|ail', 1);`));
    const [line] = h.service.definition(column.document, column.document.positionAt(column.offset), h.workspace) ?? [];
    assert.ok(line.uri.endsWith('create_users_table.php'));
    assert.equal(line.range.start.line, 11);
  });
});

describe('code actions', () => {
  test('refresh, reset and status on query strings', () => {
    const { document, offset } = h.document(php(`DB::table('users')->where('em|ail', 1);`));
    const titles = h.service.codeActions(document, document.positionAt(offset), h.workspace, []).map((a) => a.title);
    assert.ok(titles.includes('Laravel Query: refresh database schema'));
    assert.ok(titles.includes('Laravel Query: reset usage ranks of all columns'));
    const elsewhere = h.document(php(`$x = 'pl|ain';`));
    assert.deepEqual(
      h.service.codeActions(elsewhere.document, elsewhere.document.positionAt(elsewhere.offset), h.workspace, []),
      [],
    );
  });

  test('reset of the column under the cursor when it has a rank', () => {
    h.workspace.usage.record('c:mysql:app.users.email');
    const { document, offset } = h.document(php(`DB::table('users')->where('em|ail', 1);`));
    const titles = h.service.codeActions(document, document.positionAt(offset), h.workspace, []).map((a) => a.title);
    assert.ok(titles.includes('Laravel Query: reset usage rank of users.email'));
  });
});
