# Laravel Query for Zed

Database-aware completion, hover, navigation and checks inside the strings of Laravel's query
builder, Eloquent, the schema builder, migrations, validation rules and database assertions — for
MySQL, MariaDB, PostgreSQL and SQLite.

```php
User::query()
    ->join('posts as p', function (JoinClause $join) {
        $join->on('p.|')            // p.id, p.user_id, p.title … (columns of `posts`)
    })
    ->whereHas('roles', fn ($q) => $q->where('|'))   // columns of `roles`
    ->orderBy('|');                 // columns of users and posts first, then `users.x`, `p.x` …
```

## Features

- **Tables, columns, relations, connections, indexes and operators** completed where Laravel
  expects them: `DB::table()`, `from()`, every `join*()`, `where*()` / `orWhere*()` / `having*()`,
  `select()`, `orderBy()`, `groupBy()`, `pluck()`, aggregates, `insert()` / `update()` /
  `upsert()` array keys, `create()` / `fill()` / `updateOrCreate()`, `with()` / `whereHas()` /
  `withCount()` (relation names and `with('posts:id,title')` columns), `whereRelation()`,
  `wherePivot()`, `Model::on()`, `DB::connection()`, `Schema::*()`, `Blueprint` methods in
  migrations (`dropColumn`, `renameColumn`, `after`, `index`, `foreign()->references()->on()` …),
  `Rule::exists()` / `Rule::unique()` and `'exists:table,column'` rule strings,
  `assertDatabaseHas()` and friends, model properties (`$fillable`, `$hidden`, `$casts`,
  `casts()`, `$table`, `$connection`, `$with`), relation definitions (`hasMany(Post::class,
  'user_id', 'id')` keys of the right models), factory `definition()` keys. PHP files and Blade
  templates (`{{ }}`, `@php`, directive arguments).
- **The query's tables come first.** The server follows the builder chain to its root and
  collects every table the query touches:
  - roots: the `DB` facade (with `connection()`), model classes (`$table`, `$connection`,
    `#[Table]`, the name convention, parent classes and traits), `$this` and the first parameter
    of local scopes (`scopeActive($query)`, typed or not), project builders (`class GridBuilder
    extends Builder`), relations (`$user->posts()`);
  - related classes however the relation names them: `Post::class`, a class string, a property
    (`static::$postModel`, late bound, so a child model's value wins), a variable assigned in the
    method, or a runtime helper given a class path (`model_class('Lists\Post')` → the nearest
    `…\Models\Lists\Post` of the model's namespace); named arguments too. A relation whose class
    stays unknown (`morphTo`) gives no columns rather than the parent's;
  - the tables local scopes join and the names they select `as`: `->withAuthor()` adds what
    `scopeWithAuthor()` joins, and what the scopes it calls join;
  - **repositories**: a class naming its model (`model()` returning `Post::class`, a class string
    or a helper's class path; `$this->setModel(...)` in the constructor; `$model = Post::class`) is
    its model's query — `app(PostRepository::class)->query()`, `->find()`, `->with()` …; its own
    methods go by their `@return` / return type, `return $this->query()…`, or the model they
    switch to (`$this->setModel(Comment::class); return $this->createModel();`);
  - **services and actions**: `$this->posts->query()` through typed and promoted properties,
    `@var` on properties, and `$this->posts = app(PostRepository::class)` / a typed parameter
    assigned in a method; methods by their declared return type;
  - **container keys** by the PhpStorm metadata (`.phpstorm.meta.php`, written by
    `php artisan ide-helper:meta`): `app('payments')`, `app()->make('payments')` and a project's own
    helpers (`module_app('users')->createModel()`) resolve to the class the metadata maps the key
    to. When several modules bind one key, the class found in the project with the shortest root
    namespace wins (the base module over its client-specific variants);
  - [eloquent-power-joins](https://github.com/kirschbaum-development/eloquent-power-joins):
    `joinRelationship('posts.comments')` (and the `left`/`right`/`UsingAlias` variants) completes
    the relation path and adds its tables, the join closure included;
  - joins made in `when()` / `unless()` / `tap()` closures, and the pivot table of a
    `belongsToMany` relation's query;
  - variables through assignments, `foreach`, typed parameters, `@var` / `@param` docs, and
    joins added to them in other statements (`$q->leftJoin(...)`);
  - closures of all builder methods: nested `where(fn)` / `when()` (same query), join closures
    (the joined table first), relation closures of `whereHas` / `with([...])` / `withCount` (the
    related model, nested paths like `posts.comments` too), subquery closures (`whereExists`,
    `whereIn('id', fn)` — their own `from()` first, the outer tables for correlation);
  - joins written after the cursor in the same chain;
  - **aliases**: `join('table_name as t1', …)` makes `t1.` list the columns of `table_name`;
  - chains whose root cannot be resolved (repository helpers, dynamic models) are still
    recognised as queries by their builder-only methods (`join`, `orderBy`, `whereRaw` …); the
    tables come from their joins and the qualifiers in their strings (`'users.id'`).
- **Ordering:** bare columns of the query's tables first, then `alias.column` / `table.column`,
  then matching columns of all other tables, then `database.table.column` of the other
  databases (MySQL/MariaDB) or schemas (PostgreSQL).
- **Usage ranking:** columns and tables you pick often move up. A marker shows how their rank
  moved compared with a week ago: **▲** rising, **▼** falling. Reset one column right from the
  list (the `↺ reset rank: …` item at its end) or every rank with a code action.
- **Hover** shows a column's type, nullability, default, key, foreign key and comment, or a
  table's columns, indexes, row estimate and model. **Go to definition** opens a table's models
  and migrations, a column's migration line, a relation's method.
- **Diagnostics** warn about unknown tables and columns (only when every table of the query is
  known; subquery aliases, `select … as` aliases, `withCount` columns and raw SQL are respected).
  Migrations are not checked (they name columns that were dropped or renamed since), nor are
  fragments of concatenations (`$table . '.status'`), a collection's `join(', ')`, or attribute
  names (`setAttribute()`, `isDirty()` … take accessors too). After a method the server does not
  know (a macro, a builder method of the project), only `table.column` is checked: the method may
  have selected more.
- **Fast and cached:** schemas are read with a few `information_schema` / `pg_catalog` queries,
  kept in memory with lookup indexes and cached on disk; a new session answers from the cache
  immediately and refreshes in the background. A change of the migrations table (`php artisan
  migrate`) re-reads the schema automatically. See [Performance](#performance).

## Install

Install **Laravel Query** from `zed: extensions`. On first use the extension downloads its
language server (one JavaScript file from this repository's GitHub release of the same version)
and runs it on the Node.js that Zed manages.

Until the extension is listed in the registry, install it from a clone: `zed: install dev
extension` and pick the cloned directory (Zed builds it with Rust, so `rustup` must be on Zed's
`PATH`). The server is still downloaded from the release.

The server runs next to the PHP language servers and is enabled for PHP and Blade by default. If
your settings list language servers explicitly, keep `"..."` in the list or add
`"laravel-query"`:

```jsonc
"languages": {
  "PHP": { "language_servers": ["intelephense", "laravel-query", "..."] },
  "Blade": { "language_servers": ["laravel-query", "..."] }
}
```

SQLite needs Node.js 22.13 or newer (the built-in `node:sqlite`).

## Connections

The server finds the project's connections itself:

1. **PHP** (default): `php` boots the application once, like artisan, and reads
   `config('database')` — every connection with its env() defaults, ternaries and package
   overrides, and the migrations table name. Needs `vendor/` installed.
2. **`.env`**: when PHP is not available or booting fails, the `DB_*` variables describe the
   default connection.
3. **Settings**: `connections` adds connections or overrides fields of discovered ones; `false`
   drops one.

The default connection (and the ones listed in `eagerConnections` or `connections`) is read at
startup; other connections are read the first time the code uses them (`DB::connection('logs')`,
a model's `$connection`). `localhost` on MySQL/MariaDB goes through the default Unix socket, like
PHP does.

PHP in a container, the database published on the host:

```jsonc
"lsp": {
  "laravel-query": {
    "settings": {
      "php": ["docker", "compose", "exec", "-T", "app", "php"],
      "connections": { "mysql": { "host": "127.0.0.1", "port": 3307 } }
    }
  }
}
```

Several databases of one MySQL/MariaDB server — e.g. completion of `logs.audit.user_id` in a
query of the default connection:

```jsonc
"connections": { "mysql": { "databases": ["app_logs", "app_archive"] } }
```

## Commands

Zed runs language server commands through code actions (`editor: toggle code actions`,
<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd>) on a query string:

- **Laravel Query: refresh database schema** — re-reads the connections and their schemas (also
  offered as a quick fix of an unknown table/column warning);
- **Laravel Query: reset usage rank of `table.column`** — the column under the cursor;
- **Laravel Query: reset usage ranks of all columns**;
- **Laravel Query: show connections and schema status** — where connections came from, what was
  read when, errors.

## Settings

All optional, under `lsp.laravel-query.settings` (project `.zed/settings.json` or user settings):

```jsonc
{
  "discovery": "auto", // "auto" (PHP, then .env), "php", "env", "off" (settings only)
  "php": ["php"], // command that runs PHP in the project root
  "phpTimeout": 20000, // ms
  "connections": {}, // name → { driver, url, host, port, socket, username, password,
  //          database, databases, searchPath, prefix } or false
  "defaultConnection": null, // default: config('database.default')
  "eagerConnections": [], // read at startup besides the default one
  "cacheDirectory": null, // default: ~/.cache/laravel-query (macOS: ~/Library/Caches, Windows: %LOCALAPPDATA%)
  "refreshOnStartup": true, // re-read the schema in the background at startup
  "watchMigrations": 30, // seconds between checks of the migrations table; 0 = off
  "migrationPaths": ["database/migrations"],
  "metaFiles": [".phpstorm.meta.php"], // PhpStorm metadata, files or directories: container keys → classes
  "diagnostics": { "enabled": true, "severity": "warning", "unknownTables": true, "unknownColumns": true },
  "completion": {
    "maxItems": 400, // upper bound of one response
    "qualifiedColumns": true, // table.column items
    "databaseQualifiedColumns": true,
    "resetItems": true, // "↺ reset rank" items
    "operators": true
  },
  "usage": { "enabled": true, "halfLifeDays": 14 }
}
```

The cache directory holds, per project, the schemas (`schema-<connection>.json`), the
connection list without passwords and the usage statistics (`usage.json`).

## Performance

Measured with `make bench` (`server/bench/completion.bench.ts`) on an Intel Core Ultra 9 275HX,
Node.js 24, against a MariaDB 11.8 database with **1027 tables, 11 807 columns, 2762 indexes**,
completing in a 4758-line (187 KB) repository class full of joins and aliases:

| Step                                                                       | Time             |
| -------------------------------------------------------------------------- | ---------------- |
| Reading the whole schema from the database (background)                    | 92–460 ms        |
| Loading it from the disk cache at startup                                  | 5 ms             |
| Completion after an edit (parse of the file + analysis + items), p50 / p95 | 2.7 ms / 7–10 ms |
| Completion on an unchanged document, p50                                   | 0.05–0.35 ms     |
| Diagnostics of the whole file (in the background, after typing pauses)     | 5.4 ms           |

| Completion                                        | Items | Response |
| ------------------------------------------------- | ----- | -------- |
| `$join->on('actions_1.` (alias of a joined table) | 31    | 10 KiB   |
| `->where('` (query with joins, 2 tables)          | 477   | 142 KiB  |
| `->leftJoin('` (all tables)                       | 1027  | 283 KiB  |

Responses use `itemDefaults.editRange`, so the edit range is sent once per list instead of per
item. Reproduce on your project:

```sh
LQ_BENCH_ROOT=/path/to/app LQ_BENCH_FILE=app/Repositories/OrderRepository.php \
LQ_BENCH_DB=mysql://root:root@127.0.0.1:3306/app LQ_BENCH_AT="->where('|" make bench
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
