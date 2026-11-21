/** Test fixtures: a small Laravel project on disk and an in-memory schema. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import type { ConnectionConfig, DriverModule, IntrospectionResult, Table } from '../src/db/types.ts';
import { QueryService } from '../src/service.ts';
import { parseSettings, type Settings } from '../src/settings.ts';
import { Workspace } from '../src/workspace.ts';

export function table(name: string, columns: string[], extra: Partial<Table> = {}): Table {
  return {
    name,
    namespace: extra.namespace ?? 'app',
    kind: 'table',
    columns: columns.map((c) => {
      const [columnName, type = 'varchar(255)'] = c.split(':');
      return { name: columnName, type, nullable: false, key: columnName === 'id' ? 'PRI' : undefined };
    }),
    indexes: extra.indexes ?? [],
    foreignKeys: extra.foreignKeys ?? [],
    ...extra,
  };
}

export const TABLES: Table[] = [
  table('users', ['id:bigint unsigned', 'name', 'email', 'password', 'created_at:timestamp', 'updated_at:timestamp'], {
    indexes: [
      { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
      { name: 'users_email_unique', columns: ['email'], unique: true, primary: false },
    ],
  }),
  table('posts', ['id', 'user_id', 'title', 'body:text', 'published_at:timestamp', 'created_at:timestamp'], {
    foreignKeys: [
      { name: 'posts_user_id_foreign', columns: ['user_id'], foreignTable: 'users', foreignColumns: ['id'] },
    ],
  }),
  table('comments', ['id', 'post_id', 'user_id', 'content:text', 'approved:tinyint(1)']),
  table('roles', ['id', 'slug', 'label']),
  table('role_user', ['role_id', 'user_id', 'assigned_at:timestamp']),
  table('profiles', ['id', 'user_id', 'avatar', 'bio:text']),
  table('table_name', ['id', 'code', 'amount:decimal(10,2)']),
];

export const LOG_TABLES: Table[] = [table('audit_log', ['id', 'action', 'user_id'], { namespace: 'app_logs' })];

/** A driver that returns fixed tables per database. */
export function fakeDrivers(calls: string[] = []): Record<string, () => Promise<DriverModule>> {
  const driver: DriverModule = {
    async introspect(config: ConnectionConfig): Promise<IntrospectionResult> {
      calls.push(config.name);
      const namespaces = [config.database ?? 'app', ...(config.databases ?? [])];
      const all = [...TABLES, ...LOG_TABLES].filter((t) => namespaces.includes(t.namespace));
      return { defaultNamespaces: [config.database ?? 'app'], namespaces, tables: structuredClone(all) };
    },
    async migrationsMarker() {
      return '1';
    },
  };
  return {
    mysql: async () => driver,
    mariadb: async () => driver,
    pgsql: async () => driver,
    sqlite: async () => driver,
  };
}

export interface FixtureProject {
  root: string;
  write(relative: string, content: string): string;
  cleanup(): void;
}

const USER_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\HasMany;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;

class User extends Authenticatable
{
    protected $fillable = ['name', 'email'];

    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }

    public function roles()
    {
        return $this->belongsToMany(Role::class);
    }

    public function profile()
    {
        return $this->hasOne(Profile::class, 'user_id');
    }

    public function scopeActive($query)
    {
        return $query->whereNotNull('email');
    }
}
`;

const MODELS: Record<string, string> = {
  'app/Models/User.php': USER_MODEL,
  'app/Models/Post.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Post extends Model
{
    public function comments()
    {
        return $this->hasMany(Comment::class);
    }

    public function author()
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
`,
  'app/Models/Comment.php': `<?php
namespace App\\Models;

class Comment extends BaseModel
{
    public function post()
    {
        return $this->belongsTo(Post::class);
    }
}
`,
  'app/Models/BaseModel.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

abstract class BaseModel extends Model
{
}
`,
  'app/Models/Role.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Role extends Model {}
`,
  'app/Models/Profile.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Profile extends Model {}
`,
  'app/Models/AuditLog.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class AuditLog extends Model
{
    protected $connection = 'logs';
    protected $table = 'audit_log';
}
`,
  'database/migrations/2024_01_01_000000_create_users_table.php': `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('email')->unique();
        });
    }
};
`,
};

export function createProject(files: Record<string, string> = {}): FixtureProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-query-'));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write('composer.json', JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }));
  for (const [relative, content] of Object.entries({ ...MODELS, ...files })) {
    write(relative, content);
  }
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export interface Harness {
  project: FixtureProject;
  workspace: Workspace;
  service: QueryService;
  /** Completion labels at `|` in `source` (a PHP file in app/). */
  labels(source: string, file?: string): Promise<string[]>;
  /** Like closing the document: forget its parse and unsaved class content. */
  close(file: string): void;
  complete(source: string, file?: string): Promise<ReturnType<QueryService['complete']>>;
  document(source: string, file?: string): { document: TextDocument; offset: number };
  cleanup(): void;
}

export async function createHarness(
  overrides: Record<string, unknown> = {},
  files: Record<string, string> = {},
): Promise<Harness> {
  const project = createProject(files);
  const settings: Settings = parseSettings({
    discovery: 'off',
    cacheDirectory: path.join(project.root, '.cache'),
    refreshOnStartup: true,
    watchMigrations: 0,
    connections: {
      mysql: { driver: 'mysql', host: '127.0.0.1', database: 'app' },
      logs: { driver: 'mysql', host: '127.0.0.1', database: 'app_logs' },
    },
    defaultConnection: 'mysql',
    ...overrides,
  });
  const workspace = new Workspace(project.root, settings, { log: () => undefined, drivers: fakeDrivers() });
  await workspace.ready;
  await workspace.store.ready('logs');
  const service = new QueryService();
  let version = 0;
  const document = (source: string, file = 'app/Http/Controllers/TestController.php') => {
    // `‸` marks the cursor where the code itself contains `|`
    const marker = source.includes('‸') ? '‸' : '|';
    const offset = source.indexOf(marker);
    const text = offset >= 0 ? source.slice(0, offset) + source.slice(offset + marker.length) : source;
    const uri = URI.file(path.join(project.root, file)).toString();
    return {
      document: TextDocument.create(uri, file.endsWith('.blade.php') ? 'blade' : 'php', ++version, text),
      offset,
    };
  };
  const complete = async (source: string, file?: string) => {
    const { document: doc, offset } = document(source, file);
    return service.complete(doc, doc.positionAt(offset), workspace);
  };
  return {
    project,
    workspace,
    service,
    document,
    complete,
    async labels(source: string, file?: string) {
      const list = await complete(source, file);
      if (!list) {
        return [];
      }
      return [...list.items]
        .sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))
        .map((i) => i.label);
    },
    close(file: string) {
      service.forget(URI.file(path.join(project.root, file)).toString(), workspace);
    },
    cleanup() {
      workspace.dispose();
      project.cleanup();
    },
  };
}

/** Wraps a snippet in a PHP file with the usual imports. */
export function php(body: string): string {
  return `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Models\\Post;
use App\\Models\\AuditLog;
use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Database\\Query\\JoinClause;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Schema;
use Illuminate\\Validation\\Rule;

class TestController
{
    public function index(User $user)
    {
        ${body}
    }
}
`;
}
