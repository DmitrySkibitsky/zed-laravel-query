/**
 * Coverage on a real project and database: completes at every string argument of a cataloged
 * query method (`where`, `pluck`, `with`, `join` …) and checks the value already written there is
 * among the items. Reports what resolves, what gets an empty list, a list without the value
 * (missing tables), or no context at all, grouped by the receiver it starts from; and every
 * diagnostic of the files (false positives show up here).
 *
 *   LQ_AUDIT_ROOT=/path/to/laravel-app LQ_AUDIT_DIR=packages/billing \
 *   LQ_AUDIT_DB=mysql://root:root@127.0.0.1:3306/app \
 *   LQ_AUDIT_OUT=/tmp/after.json LQ_AUDIT_COMPARE=/tmp/before.json node bench/coverage.ts
 *
 * LQ_AUDIT_DIR (relative to the root, default the root) limits the files; LQ_AUDIT_OUT saves every
 * row as JSON; LQ_AUDIT_COMPARE lists the arguments that resolved in an earlier run and do not now.
 * "No context" also counts strings that are not queries (`$request->get('x')`): compare runs,
 * not absolute numbers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { siteOf } from '../src/analysis/chain.ts';
import { contextAt } from '../src/analysis/context.ts';
import { Analyzer } from '../src/analysis/scope.ts';
import {
  BLUEPRINT_METHODS,
  BUILDER_METHODS,
  DB_METHODS,
  kindsAt,
  rulesFor,
  SCHEMA_METHODS,
} from '../src/laravel/methods.ts';
import { literalValue } from '../src/php/document.ts';
import { isBlade, QueryService } from '../src/service.ts';
import { parseSettings } from '../src/settings.ts';
import { Workspace } from '../src/workspace.ts';

type Status = 'ok' | 'empty' | 'value-missing' | 'no-context';

interface Row {
  file: string;
  line: number;
  method: string;
  value: string;
  receiver: string;
  status: Status;
  tables?: string[];
}

interface Finding {
  file: string;
  line: number;
  message: string;
}

const root = path.resolve(process.env.LQ_AUDIT_ROOT ?? process.cwd());
const dir = path.resolve(root, process.env.LQ_AUDIT_DIR ?? '.');
const db = process.env.LQ_AUDIT_DB ?? 'mysql://root:root@127.0.0.1:3306/app';
const catalogs = [BUILDER_METHODS, DB_METHODS, SCHEMA_METHODS, BLUEPRINT_METHODS];

const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-query-coverage-'));
const settings = parseSettings({
  discovery: 'off',
  cacheDirectory,
  watchMigrations: 0,
  connections: { audit: { url: db } },
  defaultConnection: 'audit',
});
const workspace = new Workspace(root, settings, { log: () => undefined });
await workspace.ready;
const service = new QueryService();

function phpFiles(from: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const file = path.join(from, entry.name);
    if (entry.isDirectory()) {
      if (!['vendor', 'node_modules', '.git', 'storage'].includes(entry.name)) {
        phpFiles(file, out);
      }
    } else if (entry.name.endsWith('.php')) {
      out.push(file);
    }
  }
  return out;
}

/** The value as an item label would show it, or undefined when it cannot be compared. */
function comparable(value: string, kinds: string[]): string | undefined {
  const bare = value.trim().replace(/\s+as\s+\S+$/i, '');
  if (!bare || kinds.includes('operator') || /[\s()*`"'$>]/.test(bare)) {
    return undefined;
  }
  return kinds.includes('relation') ? bare.split(':')[0].split('.')[0] : bare;
}

const rows: Row[] = [];
const findings: Finding[] = [];
let version = 0;
const files = phpFiles(dir);
for (const file of files) {
  const uri = URI.file(file).toString();
  const document = TextDocument.create(uri, isBlade(uri) ? 'blade' : 'php', ++version, fs.readFileSync(file, 'utf8'));
  const relative = path.relative(dir, file);
  const doc = service.parse(document);
  const analyzer = new Analyzer(doc, workspace.project);
  for (let i = 0; i < doc.length; i++) {
    const token = doc.stringAt(i);
    if (!token || token.interpolated || token.quote.startsWith('<<<')) {
      continue;
    }
    const site = siteOf(doc, i);
    if (site?.type !== 'call' || (site.kind !== 'method' && site.kind !== 'static')) {
      continue;
    }
    if (!catalogs.some((catalog) => kindsAt(rulesFor(catalog, site.name), site.argIndex).length > 0)) {
      continue;
    }
    const statement = doc.tok(doc.statementStart(site.nameTok))?.start ?? token.start;
    const row: Row = {
      file: relative,
      line: document.positionAt(token.start).line + 1,
      method: site.name,
      value: literalValue(token) ?? '',
      receiver: doc.text
        .slice(statement, doc.tok(site.nameTok)?.end ?? token.start)
        .replace(/\s+/g, ' ')
        .slice(-120),
      status: 'no-context',
    };
    rows.push(row);
    const context = contextAt(analyzer, i);
    if (!context) {
      continue;
    }
    row.tables = context.scope.tables.map((t) => (t.alias ? `${t.name} as ${t.alias}` : t.name));
    const labels = (service.complete(document, document.positionAt(token.contentStart), workspace)?.items ?? []).map(
      (item) => item.label.toLowerCase(),
    );
    const want = comparable(row.value, context.kinds);
    row.status = labels.length === 0 ? 'empty' : want && !labels.includes(want.toLowerCase()) ? 'value-missing' : 'ok';
  }
  for (const diagnostic of service.diagnostics(document, workspace)) {
    const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
    findings.push({ file: relative, line: diagnostic.range.start.line + 1, message });
  }
}

const count = (status: Status) => rows.filter((r) => r.status === status).length;
console.log(
  `${files.length} files, ${rows.length} arguments: ok ${count('ok')}, empty ${count('empty')}, ` +
    `value missing ${count('value-missing')}, no context ${count('no-context')}; ${findings.length} diagnostics`,
);

const top = (title: string, keys: string[], n = 15) => {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`\n${title}`);
  for (const [key, value] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, n)) {
    console.log(`${String(value).padStart(6)}  ${key}`);
  }
};
// The receiver up to its first call: where resolution stopped.
const rootOf = (r: Row) => r.receiver.replace(/^.*?=\s*/, '').replace(/\(.*$/, '(…)');
top(
  'Unresolved (empty or no context) by receiver',
  rows.filter((r) => r.status === 'empty' || r.status === 'no-context').map(rootOf),
);
top(
  'Diagnostics by message',
  findings.map((f) => f.message.replace(/'[^']*'/g, "'…'")),
);

if (process.env.LQ_AUDIT_COMPARE) {
  const previous: Row[] = JSON.parse(fs.readFileSync(process.env.LQ_AUDIT_COMPARE, 'utf8')).rows;
  const key = (r: Row) => `${r.file}:${r.line}:${r.method}:${r.value}`;
  const before = new Map(previous.map((r) => [key(r), r]));
  const regressions = rows.filter((r) => before.get(key(r))?.status === 'ok' && r.status !== 'ok');
  console.log(`\nResolved before, not now: ${regressions.length}`);
  for (const r of regressions.slice(0, 30)) {
    console.log(
      `  ${r.status}  ${r.file}:${r.line}  ${r.method}('${r.value}')  tables: ${(r.tables ?? []).join(', ')}`,
    );
  }
}
if (process.env.LQ_AUDIT_OUT) {
  fs.writeFileSync(process.env.LQ_AUDIT_OUT, JSON.stringify({ rows, findings }, null, 1));
}
workspace.dispose();
fs.rmSync(cacheDirectory, { recursive: true, force: true });
