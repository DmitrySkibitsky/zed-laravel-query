/** Scope tables → schema tables; column/table references → schema objects. */
import type { Scope, TableRef } from '../analysis/scope.ts';
import type { SchemaIndex, SchemaStore } from '../db/schema.ts';
import type { Column, Table } from '../db/types.ts';

export interface ResolvedTable {
  ref: TableRef;
  table: Table;
  index: SchemaIndex;
  /** How the code refers to it in `x.column`: the alias, else the table reference. */
  qualifier: string;
}

/** The connection a table reference belongs to (model connection, `DB::connection()`, default). */
export function indexFor(store: SchemaStore, scope: Scope, ref?: TableRef): SchemaIndex | undefined {
  const name = ref?.connection ?? ref?.model?.connection ?? scope.connection;
  return store.get(name) ?? (name && !store.config(name) ? store.get() : undefined);
}

export function resolveTables(store: SchemaStore, scope: Scope): ResolvedTable[] {
  const out: ResolvedTable[] = [];
  const seen = new Set<Table>();
  for (const ref of scope.tables) {
    const index = indexFor(store, scope, ref);
    const table = index ? findTable(store, index, ref.name) : undefined;
    if (!index || !table) {
      continue;
    }
    const qualifier = ref.alias ?? ref.name;
    if (seen.has(table) && !ref.alias) {
      continue;
    }
    seen.add(table);
    out.push({ ref, table, index: table.namespace && !index.hasNamespace(table.namespace) ? index : index, qualifier });
  }
  return out;
}

/** A table by reference; `db.table` may live in a sibling connection on the same server. */
export function findTable(store: SchemaStore, index: SchemaIndex, reference: string): Table | undefined {
  const direct = index.findTable(reference);
  if (direct) {
    return direct;
  }
  const dot = reference.indexOf('.');
  if (dot > 0) {
    for (const sibling of store.siblings(index)) {
      const table = sibling.findTable(reference);
      if (table) {
        return table;
      }
    }
  }
  return undefined;
}

export interface ColumnMatch {
  resolved?: ResolvedTable;
  table: Table;
  column: Column;
}

/**
 * The column a string names: `column`, `qualifier.column`, `db.table.column`; `x as y`,
 * `json->path` and `table.*` are reduced first. Undefined when it does not exist.
 */
export function findColumn(
  store: SchemaStore,
  scope: Scope,
  resolved: ResolvedTable[],
  value: string,
): ColumnMatch | undefined {
  const name = columnPart(value);
  if (!name) {
    return undefined;
  }
  const parts = name.split('.');
  const column = parts[parts.length - 1];
  if (parts.length === 1) {
    for (const r of resolved) {
      const found = r.index.column(r.table, column);
      if (found) {
        return { resolved: r, table: r.table, column: found };
      }
    }
    return undefined;
  }
  const qualifier = parts.slice(0, -1).join('.');
  const lower = qualifier.toLowerCase();
  for (const r of resolved) {
    if (
      r.qualifier.toLowerCase() === lower ||
      r.table.name.toLowerCase() === lower ||
      `${r.table.namespace}.${r.table.name}`.toLowerCase() === lower
    ) {
      const found = r.index.column(r.table, column);
      return found ? { resolved: r, table: r.table, column: found } : undefined;
    }
  }
  const index = indexFor(store, scope);
  const table = index ? findTable(store, index, qualifier) : undefined;
  if (index && table) {
    const found = index.column(table, column);
    return found ? { table, column: found } : undefined;
  }
  return undefined;
}

/** `users.name as n` → `users.name`; `meta->a->b` → `meta`; `count(*)`/`*` → undefined. */
export function columnPart(value: string): string | undefined {
  let name = value.trim();
  const as = /^(.+?)\s+as\s+\S+$/i.exec(name);
  if (as) {
    name = as[1].trim();
  }
  const arrow = name.indexOf('->');
  if (arrow >= 0) {
    name = name.slice(0, arrow);
  }
  if (!name || name.endsWith('*') || /[\s()'"`,+\-/<>=!]/.test(name)) {
    return undefined;
  }
  return name;
}

export function columnType(column: Column): string {
  return column.type;
}
