/**
 * Completion latency on a real project and database.
 *
 *   LQ_BENCH_ROOT=/path/to/laravel-app LQ_BENCH_FILE=app/Repositories/X.php \
 *   LQ_BENCH_DB=mysql://root:root@127.0.0.1:3306/demo1 \
 *   LQ_BENCH_AT="where('|;->on('actions_1.|" node bench/completion.bench.ts
 *
 * LQ_BENCH_AT lists cursor positions as text before `|` (`;`-separated, first occurrence).
 * Each position is measured cold (new document version: parse + analysis + items) and warm.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { QueryService } from '../src/service.ts';
import { parseSettings } from '../src/settings.ts';
import { Workspace } from '../src/workspace.ts';

const root = process.env.LQ_BENCH_ROOT ?? process.cwd();
const file = process.env.LQ_BENCH_FILE;
const db = process.env.LQ_BENCH_DB ?? 'mysql://root:root@127.0.0.1:3306/demo1';
const positions = (process.env.LQ_BENCH_AT ?? "where('|").split(';').filter(Boolean);
const runs = Number(process.env.LQ_BENCH_RUNS ?? 200);

if (!file) {
  console.error('set LQ_BENCH_FILE (relative to LQ_BENCH_ROOT)');
  process.exit(1);
}

const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-query-bench-'));
const settings = parseSettings({
  discovery: 'off',
  cacheDirectory,
  watchMigrations: 0,
  connections: { mysql: { url: db } },
  defaultConnection: 'mysql',
});

const t0 = performance.now();
const workspace = new Workspace(root, settings, { log: (m) => console.log(m) });
await workspace.ready;
console.log(`schema ready in ${(performance.now() - t0).toFixed(0)} ms (introspection, no cache)`);

const t1 = performance.now();
const again = new Workspace(root, settings, { log: () => undefined });
again.store.get();
console.log(`schema from disk cache in ${(performance.now() - t1).toFixed(1)} ms`);
again.dispose();

const source = fs.readFileSync(path.join(root, file), 'utf8');
const uri = URI.file(path.join(root, file)).toString();
const service = new QueryService();
service.insertReplace = true;
service.editRangeDefault = true;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

let version = 1;
for (const spec of positions) {
  const [before, after = ''] = spec.split('|');
  const at = source.indexOf(before + after);
  if (at < 0) {
    console.log(`${spec}: not found`);
    continue;
  }
  const offset = at + before.length;
  const cold: number[] = [];
  const warm: number[] = [];
  let count = 0;
  let sample = '';
  for (let i = 0; i < runs; i++) {
    const document = TextDocument.create(uri, 'php', ++version, source);
    const position = document.positionAt(offset);
    let start = performance.now();
    const list = service.complete(document, position, workspace);
    cold.push(performance.now() - start);
    start = performance.now();
    service.complete(document, position, workspace);
    warm.push(performance.now() - start);
    count = list?.items.length ?? 0;
    sample =
      list?.items
        .slice()
        .sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))
        .slice(0, 6)
        .map((item) => item.label)
        .join(', ') ?? '';
    if (i === 0) {
      const bytes = JSON.stringify(list ?? null).length;
      console.log(`${spec}: ${count} items, ${(bytes / 1024).toFixed(0)} KiB JSON; top: ${sample}`);
    }
  }
  console.log(
    `  cold p50 ${percentile(cold, 50).toFixed(2)} ms, p95 ${percentile(cold, 95).toFixed(2)} ms | warm p50 ${percentile(warm, 50).toFixed(2)} ms, p95 ${percentile(warm, 95).toFixed(2)} ms`,
  );
}
const diagnosticsRuns: number[] = [];
for (let i = 0; i < 20; i++) {
  const document = TextDocument.create(uri, 'php', ++version, source);
  const start = performance.now();
  service.diagnostics(document, workspace);
  diagnosticsRuns.push(performance.now() - start);
}
console.log(`diagnostics of the whole file: p50 ${percentile(diagnosticsRuns, 50).toFixed(1)} ms`);
workspace.dispose();
fs.rmSync(cacheDirectory, { recursive: true, force: true });
