import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CompletionItem } from 'vscode-languageserver/node';
import { createHarness, type Harness, php } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(() => h.cleanup());

const labels = (body: string) => h.labels(php(body));
const top = async (body: string, n = 6) => (await labels(body)).slice(0, n);
const items = async (body: string): Promise<CompletionItem[]> => {
  const list = await h.complete(php(body));
  return [...(list?.items ?? [])].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
};

describe('tables', () => {
  test('DB::table, joins, from: tables of the default database, other databases as prefixes', async () => {
    const result = await labels(`DB::table('|');`);
    assert.ok(result.includes('users') && result.includes('role_user'));
    assert.ok(result.includes('app_logs.'), 'another database on the same server');
    assert.ok((await labels(`DB::table('users')->join('|');`)).includes('posts'));
    assert.ok((await labels(`DB::query()->from('|');`)).includes('posts'));
    assert.ok((await labels(`Schema::hasTable('|');`)).includes('posts'));
  });

  test('tables of another database after its prefix', async () => {
    assert.deepEqual(await labels(`DB::table('app_logs.|');`), ['app_logs.audit_log']);
  });

  test('DB::connection() picks the connection', async () => {
    // Same server: the default connection's database is reachable as a prefix.
    assert.deepEqual(await labels(`DB::connection('logs')->table('|');`), ['audit_log', 'app.']);
    assert.deepEqual((await labels(`DB::connection('|');`)).sort(), ['logs', 'mysql']);
  });

  test('nothing after an alias or in raw expressions', async () => {
    assert.deepEqual(await labels(`DB::table('users as |');`), []);
    assert.deepEqual(await labels(`DB::table('users')->select('count(|');`), []);
  });
});

describe('columns', () => {
  test('bare columns of the query table first, then qualified ones', async () => {
    const result = await labels(`DB::table('users')->where('|');`);
    assert.deepEqual(result.slice(0, 6), ['id', 'name', 'email', 'password', 'created_at', 'updated_at']);
    assert.deepEqual(result.slice(6, 8), ['users.id', 'users.name']);
  });

  test('typed text adds matching columns of other tables, then of other databases', async () => {
    const result = await labels(`DB::table('posts')->where('us|');`);
    assert.equal(result[0], 'id');
    const firstOther = result.findIndex((l) => l.startsWith('comments.'));
    const lastOwn = result.lastIndexOf('posts.created_at');
    assert.ok(firstOther > lastOwn, 'other tables after the query table');
    assert.ok(result.includes('comments.user_id'));
    assert.ok(result.includes('profiles.user_id'));
    assert.ok(result.includes('app_logs.audit_log.user_id'), 'db.table.column of the other database');
    assert.ok(result.indexOf('app_logs.audit_log.user_id') > result.indexOf('comments.user_id'));
  });

  test('typing a table name offers its columns', async () => {
    const result = await labels(`DB::table('posts')->where('rol|');`);
    assert.ok(result.includes('roles.slug'));
  });

  test('the list is incomplete: Zed asks again while typing', async () => {
    const list = await h.complete(php(`DB::table('users')->where('|');`));
    assert.equal(list?.isIncomplete, true);
  });

  test('Eloquent models: static calls, query(), instances, relations', async () => {
    assert.equal((await top(`User::where('|');`))[1], 'name');
    assert.equal((await top(`User::query()->orderBy('|');`))[1], 'name');
    assert.ok((await top(`$user->posts()->where('|');`)).includes('title'));
    assert.ok((await top(`$user->roles()->where('|');`)).includes('slug'));
    assert.ok((await top(`(new Post)->newQuery()->where('|');`)).includes('title'));
    assert.ok((await top(`AuditLog::where('|');`)).includes('action'), "model's own connection");
  });

  test('joins add their tables; columns of the joined table are offered too', async () => {
    const result = await labels(`DB::table('users')->join('posts', 'posts.user_id', '=', 'users.id')->where('|');`);
    assert.ok(result.indexOf('title') > result.indexOf('email'), 'main table first');
    assert.ok(result.includes('posts.title'));
  });

  test('joins after the cursor belong to the query', async () => {
    const result = await labels(
      `DB::table('users')->where('|')->leftJoin('profiles', 'profiles.user_id', '=', 'users.id');`,
    );
    assert.ok(result.includes('avatar'));
  });

  test("join's own table in its column arguments", async () => {
    const result = await labels(`DB::table('users')->join('posts as p', 'p.|');`);
    assert.deepEqual(result.slice(0, 2), ['p.id', 'p.user_id']);
  });

  test('aliases: `t1.` lists the aliased table', async () => {
    const result = await labels(
      `DB::table('users as u')->join('table_name as t1', function ($join) { $join->where('t1.|'); });`,
    );
    assert.deepEqual(result, ['t1.id', 't1.code', 't1.amount']);
    const outer = await labels(
      `DB::table('users as u')->join('table_name as t1', function ($join) { $join->on('u.|'); });`,
    );
    assert.ok(outer.includes('u.email'));
  });

  test('join closure: the joined table first, then the outer query', async () => {
    const result = await labels(`User::query()->join('posts', function (JoinClause $join) { $join->on('|'); });`);
    assert.equal(result[1], 'user_id');
    assert.ok(result.includes('email'));
  });

  test('nested where closures keep the query tables', async () => {
    assert.equal((await top(`DB::table('users')->where(function ($q) { $q->where('|'); });`))[1], 'name');
    assert.equal((await top(`User::query()->when($x, fn ($q) => $q->where('|'));`))[1], 'name');
    assert.equal(
      (await top(`User::where(function (Builder $q) { $q->orWhere(fn ($q2) => $q2->where('|')); });`))[1],
      'name',
    );
  });

  test('relation closures: whereHas, with, withCount', async () => {
    assert.ok((await top(`User::whereHas('posts', function ($q) { $q->where('|'); });`)).includes('title'));
    assert.ok((await top(`User::with(['posts' => fn ($q) => $q->orderBy('|')]);`)).includes('title'));
    assert.ok((await top(`User::withCount(['roles' => fn ($q) => $q->where('|')]);`)).includes('slug'));
    assert.ok((await top(`User::whereHas('posts.comments', fn ($q) => $q->where('|'));`)).includes('content'));
  });

  test('subquery closures: own from() first, outer tables for correlation', async () => {
    const result = await labels(
      `DB::table('users')->whereExists(function ($q) { $q->from('posts')->whereColumn('|'); });`,
    );
    assert.equal(result[1], 'user_id');
    assert.ok(result.includes('email'));
  });

  test('variables: assignments, other statements, typed parameters, @var', async () => {
    const assigned = await labels(
      `$q = User::query();\n$q->leftJoin('profiles', 'profiles.user_id', '=', 'users.id');\n$q->where('|');`,
    );
    assert.ok(assigned.includes('name') && assigned.includes('avatar'));
    assert.equal((await top(`/** @var Post $post */\n$post->update(['|' => 1]);`))[2], 'title');
    assert.ok((await top(`foreach (User::all() as $u) { $u->posts()->where('|'); }`)).includes('title'));
  });

  test('@var over an assignment the right-hand side cannot type', async () => {
    // `‸` marks the cursor: `|` belongs to the union type.
    const unknownRhs = `$job = app(JobRepository::class)->query()->find($id);`;
    assert.ok((await top(`/** @var User|Post $job */\n${unknownRhs}\n$job->roles()->pluck('‸');`)).includes('slug'));
    assert.ok((await top(`/** @var User $job */\n${unknownRhs}\n$job->posts()->pluck('‸');`)).includes('title'));
    assert.ok((await top(`${unknownRhs}\n/** @var Post $job */\n$job->where('‸');`)).includes('title'));
    // A doc far above is only a fallback: a resolved assignment wins.
    assert.ok((await top(`/** @var User $job */\nfoo();\n$job = Post::query();\n$job->where('‸');`)).includes('title'));
  });

  test('scopes and $this inside a model', async () => {
    const model = `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Builder;
class Post extends Model
{
    protected $fillable = ['|'];
    public function scopePublished(Builder $query) { return $query->whereNotNull(''); }
}`;
    const fillable = await h.labels(model, 'app/Models/Post.php');
    assert.ok(fillable.includes('title'));
    const scope = await h.labels(
      model.replace("['|']", '[]').replace("whereNotNull('')", "whereNotNull('|')"),
      'app/Models/Post.php',
    );
    assert.ok(scope.includes('published_at'));
    h.close('app/Models/Post.php');
  });

  test('array keys: where([...]), create(), update(), factories', async () => {
    assert.ok((await top(`User::where(['|' => 1]);`)).includes('email'));
    assert.ok((await top(`User::create(['name' => 'x', '|' => 1]);`)).includes('email'));
    assert.ok((await top(`User::updateOrCreate(['email' => 'x'], ['|' => 1]);`)).includes('name'));
    assert.ok((await top(`DB::table('users')->where([['|', '=', 1]]);`)).includes('email'));
    assert.deepEqual(await labels(`User::where(['email' => '|']);`), [], 'values are not columns');
  });

  test('columns in arrays: select([...]), groupBy, pluck', async () => {
    assert.ok((await top(`DB::table('users')->select(['id', '|']);`)).includes('email'));
    assert.ok((await top(`User::query()->pluck('|');`)).includes('email'));
    assert.ok((await top(`User::query()->get(['|']);`)).includes('email'));
  });

  test('operators in the comparison argument of a three-argument where', async () => {
    const result = await labels(`DB::table('users')->where('id', '|', 1);`);
    assert.equal(result[0], '=');
    assert.ok(result.includes('like'));
    assert.deepEqual(await labels(`DB::table('users')->where('id', '|');`), [], 'a value, not an operator');
  });

  test('whereRelation: columns of the related model', async () => {
    assert.ok((await top(`User::whereRelation('posts', '|', 'x');`)).includes('title'));
  });

  test('pivot columns of belongsToMany', async () => {
    assert.ok((await labels(`$user->roles()->wherePivot('|', 1);`)).includes('assigned_at'));
  });

  test('test assertions', async () => {
    const test = `<?php
class UserTest extends TestCase {
    public function test_it() { $this->assertDatabaseHas('users', ['|' => 'x']); }
}`;
    assert.ok((await h.labels(test, 'tests/UserTest.php')).includes('email'));
    const pest = `<?php\nit('works', function () { $this->assertDatabaseMissing('|'); });`;
    assert.ok((await h.labels(pest, 'tests/Feature/UserTest.php')).includes('users'));
  });

  test('validation rules: exists / unique', async () => {
    assert.ok((await labels(`$rules = ['email' => 'required|exists:‸'];`)).includes('users'));
    assert.ok((await labels(`$rules = ['email' => 'required|exists:users,‸'];`)).includes('email'));
    assert.ok((await labels(`$rules = ['email' => 'required|exists:logs.‸'];`)).includes('logs.audit_log'));
    assert.ok((await labels(`$rules = ['email' => ['required', 'unique:posts,|']];`)).includes('title'));
    assert.ok((await labels(`Rule::unique('users', '|');`)).includes('email'));
    assert.ok((await labels(`Rule::exists('posts')->where('|', 1);`)).includes('title'));
  });

  test('schema builder and migrations', async () => {
    assert.ok((await labels(`Schema::hasColumn('posts', '|');`)).includes('title'));
    assert.ok(
      (await labels(`Schema::table('users', function (Blueprint $table) { $table->dropColumn('|'); });`)).includes(
        'email',
      ),
    );
    assert.ok(
      (await labels(`Schema::table('users', function ($table) { $table->string('|')->change(); });`)).includes('name'),
    );
    assert.deepEqual(
      await labels(`Schema::create('users', function ($table) { $table->string('|'); });`),
      [],
      'new columns are named, not completed',
    );
    assert.ok(
      (
        await labels(
          `Schema::table('posts', function ($table) { $table->foreign('user_id')->references('|')->on('users'); });`,
        )
      ).includes('email'),
    );
    assert.ok(
      (await labels(`Schema::table('users', function ($table) { $table->dropIndex('|'); });`)).includes(
        'users_email_unique',
      ),
    );
  });

  test('relations: with(), has(), nested paths', async () => {
    assert.deepEqual((await labels(`User::with('|');`)).sort(), ['posts', 'profile', 'roles']);
    assert.deepEqual((await labels(`User::with('posts.|');`)).sort(), ['posts.author', 'posts.comments']);
    assert.ok((await labels(`User::with('posts:|');`)).includes('title'), 'columns after the colon');
    assert.ok((await labels(`User::whereHas('|');`)).includes('posts'));
  });

  test('relation definitions: keys of the right models', async () => {
    const model = (args: string) => `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Post extends Model
{
    public function author() { return $this->belongsTo(User::class, ${args}); }
}`;
    assert.ok((await h.labels(model(`'|'`), 'app/Models/Post.php')).includes('published_at'), 'foreign key on posts');
    assert.ok((await h.labels(model(`'user_id', '|'`), 'app/Models/Post.php')).includes('email'), 'owner key on users');
    h.close('app/Models/Post.php');
  });

  test('model connection property', async () => {
    const model = `<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Post extends Model { protected $connection = '|'; }`;
    assert.deepEqual((await h.labels(model, 'app/Models/Post.php')).sort(), ['logs', 'mysql']);
    h.close('app/Models/Post.php');
  });

  test('queries of an unresolvable root are recognized by builder-only methods', async () => {
    const result = await labels(`$this->grid()->join('posts', 'posts.user_id', '=', 'users.id')->where('users.|');`);
    assert.ok(result.includes('users.email'));
    const mentioned = await labels(`$data = $this->grid()->orderBy('users.id');\n$data->where('|');`);
    assert.ok(mentioned.includes('email'), 'tables named in qualifiers');
  });

  test('no completion outside query contexts', async () => {
    assert.deepEqual(await labels(`$x = collect($a)->where('|');`), []);
    assert.deepEqual(await labels(`$x = config('|');`), []);
    assert.deepEqual(await labels(`Cache::get('|');`), []);
    assert.deepEqual(await labels(`$x = ['|'];`), []);
  });

  test('a string being typed without its closing quote', async () => {
    const result = await h.labels(php(`DB::table('users')->where('na|\n        $other = 'x';`));
    assert.ok(result.includes('name'));
  });

  test('Blade templates', async () => {
    const blade = `<div title="it's">{{ App\\Models\\User::query()->value('|') }}</div>\n@if ($x)\n@endif`;
    assert.ok((await h.labels(blade, 'resources/views/users.blade.php')).includes('email'));
    const php = `@php\n$users = DB::table('users')->orderBy('|')->get();\n@endphp`;
    assert.ok((await h.labels(php, 'resources/views/list.blade.php')).includes('email'));
  });
});

describe('items', () => {
  test('replace the whole string part, record usage when picked', async () => {
    const [first] = await items(`DB::table('users')->where('na|me');`);
    assert.equal(first.label, 'id');
    assert.equal(first.command?.command, 'laravelQuery.recordUsage');
    const edit = first.textEdit as { range: { start: { character: number }; end: { character: number } } };
    assert.ok(edit.range.end.character - edit.range.start.character === 4, 'replaces `name`');
  });

  test('usage ranking lifts picked columns and marks their trend', async () => {
    const pick = (await items(`DB::table('users')->where('|');`)).find((i) => i.label === 'password');
    assert.ok(pick?.command?.arguments);
    h.workspace.usage.record(pick.command.arguments[0]);
    h.workspace.usage.record(pick.command.arguments[0]);
    const ranked = await items(`DB::table('users')->where('|');`);
    assert.equal(ranked[0].label, 'password');
    assert.match(ranked[0].detail ?? '', /^▲ users/);
    const reset = ranked.find((i) => i.label.startsWith('↺'));
    assert.equal(reset?.label, '↺ reset rank: password');
    assert.equal(reset?.command?.command, 'laravelQuery.resetUsage');
    assert.equal(ranked[ranked.length - 1], reset, 'reset items last');
    h.workspace.usage.reset(reset?.command?.arguments?.[0]);
    assert.equal((await items(`DB::table('users')->where('|');`))[0].label, 'id');
  });

  test('itemDefaults.editRange keeps responses small', async () => {
    h.service.editRangeDefault = true;
    try {
      const list = await h.complete(php(`DB::table('users')->where('|');`));
      assert.ok(list?.itemDefaults?.editRange);
      assert.equal(list?.items[0].textEdit, undefined);
    } finally {
      h.service.editRangeDefault = false;
    }
  });

  test('resolve adds documentation', async () => {
    const item = (await items(`DB::table('users')->where('|');`)).find((i) => i.label === 'id');
    assert.ok(item);
    const resolved = h.service.resolveCompletion(item, h.workspace);
    assert.match(String((resolved.documentation as { value: string }).value), /\*\*users\.id\*\* `bigint unsigned`/);
  });
});

describe('models outside the root composer.json', () => {
  test('nested packages, parents declared in another class file, unresolvable models', async () => {
    const files = {
      'workbench/acme/shop/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Shop\\': 'src/' } } }),
      // Two classes in one file: the parent has no file of its own.
      'workbench/acme/shop/src/Models/BaseModel.php': `<?php
namespace Acme\\Shop\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Legacy_BaseModel extends Model {}
class BaseModel extends Legacy_BaseModel {}
`,
      'workbench/acme/shop/src/Models/Order.php': `<?php
namespace Acme\\Shop\\Models;
class Order extends BaseModel { protected $table = 'posts'; }
`,
    };
    const local = await createHarness({}, files);
    try {
      const source = (body: string) => `<?php
namespace Acme\\Shop\\Actions;
use Acme\\Shop\\Models\\Order;
use Acme\\Missing\\Models\\Comment;
class Act { public function handle() { ${body} } }`;
      assert.ok(
        (
          await local.labels(source(`Order::query()->select(['|']);`), 'workbench/acme/shop/src/Actions/Act.php')
        ).includes('title'),
      );
      const guessed = await local.labels(source(`Comment::where('|');`), 'workbench/acme/shop/src/Actions/Act.php');
      assert.ok(guessed.includes('content'), 'table by convention');
      const { document } = local.document(
        source(`Comment::where('nope', 1);`),
        'workbench/acme/shop/src/Actions/Act.php',
      );
      assert.deepEqual(local.service.diagnostics(document, local.workspace), [], 'no diagnostics on guesses');
    } finally {
      local.cleanup();
    }
  });
});

describe('container and dynamic roots', () => {
  test('app(Model::class), resolve(), app()->make(), App::make()', async () => {
    for (const root of [
      'app(User::class)',
      'resolve(User::class)',
      'app()->make(User::class)',
      '\\App::make(User::class)',
    ]) {
      const result = await labels(`${root}->newQuery()->select(['|']);`);
      assert.ok(result.includes('email'), root);
    }
  });

  test('newQuery() on an unresolvable root is a query: a typed table qualifier completes', async () => {
    const result = await labels(`app_helper('job')->grid()->newQuery()->select(['posts.|']);`);
    assert.ok(result.includes('posts.title'));
  });
});

describe('Eloquent model attributes', () => {
  const model = (attributes: string) => `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Attributes\\Fillable;
use Illuminate\\Database\\Eloquent\\Attributes\\Table;
use Illuminate\\Database\\Eloquent\\Model;

${attributes}
class Post extends Model
{
    public function comments() { return $this->hasMany(Comment::class); }
}`;
  const at = async (attributes: string) => {
    const result = await h.labels(model(attributes), 'app/Models/Post.php');
    h.close('app/Models/Post.php');
    return result;
  };

  test('Fillable, Hidden, Guarded, Visible, RouteKey: columns of the model', async () => {
    assert.ok((await at(`#[Fillable(['title', '|'])]`)).includes('body'));
    assert.ok((await at(`#[Fillable(['title'])]\n#[Hidden(['|'])]`)).includes('published_at'));
    assert.ok((await at(`#[Guarded('|')]`)).includes('body'));
    assert.ok((await at(`#[ObservedBy(PostObserver::class), Visible(['|'])]`)).includes('title'));
    assert.ok((await at(`#[RouteKey('|')]`)).includes('title'));
  });

  test('Table, Connection, Touches', async () => {
    assert.ok((await at(`#[Table('|')]`)).includes('role_user'));
    assert.ok((await at(`#[Table(name: 'posts', key: '|')]`)).includes('title'));
    assert.deepEqual((await at(`#[Connection('|')]`)).sort(), ['logs', 'mysql']);
    assert.deepEqual(await at(`#[Touches(['|'])]`), ['comments']);
  });

  test('#[Table] sets the table of the model', async () => {
    const source = model(`#[Table(name: 'table_name', key: 'code')]`);
    h.workspace.project.updateClassFromText(`${h.project.root}/app/Models/Post.php`, source);
    try {
      assert.equal(h.workspace.project.model('App\\Models\\Post')?.table, 'table_name');
      assert.equal(h.workspace.project.model('App\\Models\\Post')?.primaryKey, 'code');
    } finally {
      h.workspace.project.dropOverride(`${h.project.root}/app/Models/Post.php`);
    }
  });
});
