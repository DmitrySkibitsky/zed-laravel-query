/**
 * Go to definition: a table string opens its models and the migrations that create/alter it, a
 * column string the migration lines that define it.
 */
import * as fs from 'node:fs';
import type { Location } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import type { QueryContext } from '../analysis/context.ts';
import { parseTableExpression } from '../analysis/scope.ts';
import type { SchemaStore } from '../db/schema.ts';
import type { LaravelProject } from '../laravel/project.ts';
import { targetOf } from './hover.ts';
import { columnPart, findColumn, resolveTables } from './resolve.ts';

const lineCache = new Map<string, { mtime: number; starts: number[] }>();

function positionIn(file: string, offset: number): { line: number; character: number } {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { line: 0, character: 0 };
  }
  let cached = lineCache.get(file);
  if (!cached || cached.mtime !== mtime) {
    const text = fs.readFileSync(file, 'utf8');
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        starts.push(i + 1);
      }
    }
    cached = { mtime, starts };
    lineCache.set(file, cached);
  }
  let lo = 0;
  let hi = cached.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cached.starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, character: offset - cached.starts[lo] };
}

function location(file: string, offset: number): Location {
  const position = positionIn(file, offset);
  return { uri: URI.file(file).toString(), range: { start: position, end: position } };
}

export function definition(
  context: QueryContext,
  offset: number,
  store: SchemaStore,
  project: LaravelProject | undefined,
): Location[] | null {
  if (!project) {
    return null;
  }
  const target = targetOf(context, offset);
  if (!target) {
    return null;
  }
  const kind = context.kinds[0];
  if (kind === 'table') {
    const name = parseTableExpression(target.value).name.split('.').pop() ?? '';
    const lower = name.toLowerCase();
    const out: Location[] = [];
    for (const model of project.modelsForTable(name)) {
      if (model.file) {
        out.push(location(model.file, model.offset ?? 0));
      }
    }
    for (const migration of project.migrations()) {
      for (const table of migration.tables) {
        if (table.table.toLowerCase() === lower) {
          out.push(location(table.file, table.offset));
        }
      }
    }
    return out.length ? out : null;
  }
  if (kind === 'column') {
    const name = columnPart(target.value);
    if (!name) {
      return null;
    }
    const resolved = resolveTables(store, target.scope);
    const match = findColumn(store, target.scope, resolved, name);
    const column = (name.split('.').pop() ?? name).toLowerCase();
    const tables = match
      ? [match.table.name.toLowerCase()]
      : target.scope.tables.map((t) => (t.name.split('.').pop() ?? t.name).toLowerCase());
    const out: Location[] = [];
    for (const migration of project.migrations()) {
      for (const definedColumn of migration.columns) {
        if (definedColumn.column.toLowerCase() === column && tables.includes(definedColumn.table.toLowerCase())) {
          out.push(location(definedColumn.file, definedColumn.offset));
        }
      }
    }
    return out.length ? out : null;
  }
  if (kind === 'relation' && context.relationModel) {
    const relation = context.relationModel.relations.get(target.value.split('.')[0].toLowerCase());
    if (relation && context.relationModel.file) {
      const text = fs.readFileSync(context.relationModel.file, 'utf8');
      const at = new RegExp(`function\\s+${relation.name}\\s*\\(`).exec(text);
      return [location(context.relationModel.file, at?.index ?? 0)];
    }
  }
  return null;
}
