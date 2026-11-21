import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHarness, type Harness, LEGACY_FILES, php } from './helpers.ts';

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

describe('diagnostics in long-lived codebases', () => {
  let legacy: Harness;
  before(async () => {
    legacy = await createHarness({}, LEGACY_FILES);
  });
  after(() => legacy.cleanup());

  const messages = (source: string, file?: string) => {
    const { document } = legacy.document(`${source}‸`, file);
    return legacy.service.diagnostics(document, legacy.workspace).map((d) => d.message);
  };

  test("no parent's columns for an unresolvable relation, no tables in a collection's join()", () => {
    assert.deepEqual(
      messages(php(`/** @var \\App\\Models\\Legacy\\Account $account */\n$account->owner()->where('owner_only', 1);`)),
      [],
    );
    assert.deepEqual(messages(php(`$user->posts()->pluck('title')->join(', ');`)), []);
    assert.deepEqual(
      messages(php(`User::where($table . '.nmae', 1)->orWhere('users.' . $column, 1);`)),
      [],
      'fragments',
    );
    assert.deepEqual(
      messages(php(`$user->setAttribute('full_name', 'x'); $user->isDirty('display_name');`)),
      [],
      'attributes',
    );
    assert.deepEqual(
      messages(
        php(`User::query()->addSelectDistance($lat, $lng)->having('distance', '<', 1)->where('users.nmae', 1);`),
      ),
      ["Unknown column 'users.nmae' in 'users'"],
      'after an unknown method only qualified columns are checked',
    );
  });

  test('after SQL built at runtime, bare names are not checked', () => {
    assert.deepEqual(messages(php(`User::select(DB::raw(full_name_sql('author')))->orderBy('author');`)), []);
    assert.deepEqual(
      messages(php(`$q = User::query();\n$q->selectRaw($sql);\n$q->orderBy('total');`)),
      [],
      'other statements',
    );
    assert.deepEqual(
      messages(php(`$q = User::query();\n$q->selectFullName('author');\n$q->orderBy('author');`)),
      [],
      'an unknown method in another statement',
    );
    assert.deepEqual(
      messages(php(`User::select(DB::raw('count(*) as total'))->orderBy('nmae');`)).length,
      1,
      'plain raw SQL',
    );
  });

  test('names builder macros and methods select are valid later, and bare names stay checked', () => {
    assert.deepEqual(
      messages(php(`User::selectFullName('author')->orderBy('author')->orderBy('full_nme');`)),
      ["Unknown column 'full_nme' in users"],
      'the alias argument',
    );
    assert.deepEqual(messages(php(`User::selectFullName()->orderBy('full_name');`)), [], 'its default');
    assert.deepEqual(
      messages(php(`User::selectFullName(table: 'users', alias: 'author')->orderBy('author');`)),
      [],
      'a named argument',
    );
    assert.deepEqual(
      messages(
        php(`\\App\\Models\\Legacy\\Account::addSelectDistance(1, 2)->having('distance', '<', 1)->where('nmae', 1);`),
      ),
      ["Unknown column 'nmae' in users"],
      "the model builder's method",
    );
    assert.deepEqual(messages(php(`User::selectRandomSql()->orderBy('nmae');`)), [], 'SQL built at runtime, no alias');
    assert.deepEqual(
      messages(
        php(
          `$q = User::query();\n$q->groupBy('kind')->orderBy('nmae');\n$a = (clone $q)->addSelect(DB::raw("'" . $x . "' as kind"));`,
        ),
      ),
      ["Unknown column 'nmae' in users"],
      'an alias its clones select, raw SQL naming its alias',
    );
    assert.deepEqual(
      messages(php(`User::selectFullName('a', 'author_alias');`)),
      [],
      'table parameters are not checked',
    );
  });

  test('names a local scope selects are valid later', () => {
    assert.deepEqual(
      messages(
        php(`/** @var \\App\\Models\\Legacy\\Account $account */\n$account->withPostCount()->orderBy('post_count');`),
      ),
      [],
    );
  });

  test('migrations are history: not checked against the current schema', () => {
    const migration = `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('removed_long_ago');
        });
        DB::table('old_table')->where('gone', 1)->delete();
    }
};
`;
    assert.deepEqual(messages(migration, 'database/migrations/2020_01_01_000000_drop_things.php'), []);
  });
});
