/**
 * Completion items for a query context.
 *
 * Columns come in groups (Zed ranks by fuzzy score first, `sortText` breaks ties):
 *   a  bare columns of the query's tables — most picked first, then the main table's in
 *      definition order, then the joined ones;
 *   b  `alias.column` / `table.column` of the query's tables;
 *   c  `table.column` of every other table, filtered by what is typed;
 *   d  `database.table.column` of the other databases/schemas, filtered by what is typed;
 *   z  `↺ reset rank` items of ranked columns that match.
 * The server filters groups c/d, so the list is incomplete and Zed asks again as you type.
 */
import {
  type CompletionItem,
  CompletionItemKind,
  type CompletionList,
  type InsertReplaceEdit,
  type Range,
  type TextEdit,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type QueryContext, ruleSegmentAt } from '../analysis/context.ts';
import { emptyScope, type Scope } from '../analysis/scope.ts';
import type { SchemaIndex, SchemaStore } from '../db/schema.ts';
import type { Column, Table } from '../db/types.ts';
import { OPERATORS } from '../laravel/methods.ts';
import type { LaravelProject } from '../laravel/project.ts';
import type { Settings } from '../settings.ts';
import { columnKey, type Trend, tableKey, type UsageStore } from '../usage.ts';
import { findTable, indexFor, type ResolvedTable, resolveTables } from './resolve.ts';

export const RECORD_USAGE_COMMAND = 'laravelQuery.recordUsage';
export const RESET_USAGE_COMMAND = 'laravelQuery.resetUsage';
export const REFRESH_SCHEMA_COMMAND = 'laravelQuery.refreshSchema';
export const STATUS_COMMAND = 'laravelQuery.status';

export interface CompletionEnv {
  store: SchemaStore;
  usage: UsageStore;
  settings: Settings;
  project?: LaravelProject;
  insertReplace: boolean;
  /** The client takes the edit range from `itemDefaults` (smaller responses). */
  editRangeDefault?: boolean;
  now?: number;
}

/** Item data for completionItem/resolve: [connection, namespace, table, column?]. */
export type ItemData = [string, string, string, string?];

const TREND_ICON: Record<Trend, string> = { up: '▲', down: '▼', steady: '•' };

const pad = (n: number, width: number) => String(Math.max(0, Math.min(n, 10 ** width - 1))).padStart(width, '0');

const identifierTail = /^[\w$.\u0080-\uffff-]*/;

class ItemBuilder {
  readonly items: CompletionItem[] = [];
  private readonly env: CompletionEnv;
  private readonly insertRange: Range;
  private readonly replaceRange: Range;
  readonly typed: string;
  private readonly now: number;
  /** Usage keys of columns already offered (for reset items). */
  readonly ranked = new Map<string, { label: string; filterText: string; score: number }>();

  constructor(env: CompletionEnv, document: TextDocument, start: number, cursor: number, end: number) {
    this.env = env;
    this.insertRange = { start: document.positionAt(start), end: document.positionAt(cursor) };
    this.replaceRange = { start: document.positionAt(start), end: document.positionAt(Math.max(cursor, end)) };
    this.typed = document.getText().slice(start, cursor);
    this.now = env.now ?? Date.now();
  }

  /** The edit range shared by every item (sent once as `itemDefaults.editRange`). */
  defaultRange(): Range | { insert: Range; replace: Range } {
    return this.env.insertReplace ? { insert: this.insertRange, replace: this.replaceRange } : this.replaceRange;
  }

  /** Sets the item's text edit, relying on the list default when the client supports it. */
  private setEdit(item: CompletionItem, newText: string): void {
    if (this.env.editRangeDefault) {
      if (newText !== item.label) {
        item.textEditText = newText;
      }
      return;
    }
    item.textEdit = this.edit(newText);
  }

  edit(newText: string): TextEdit | InsertReplaceEdit {
    if (this.env.insertReplace) {
      return { newText, insert: this.insertRange, replace: this.replaceRange };
    }
    return { newText, range: this.replaceRange };
  }

  /** Text that keeps the string as it is (reset items). */
  keepEdit(): TextEdit {
    return { newText: this.typed, range: this.insertRange };
  }

  usage(key: string): { rank?: number; trend?: Trend; score: number } {
    if (!this.env.settings.usage.enabled || !this.env.usage.has(key)) {
      return { score: 0 };
    }
    return {
      rank: this.env.usage.rank(key, this.now),
      trend: this.env.usage.trend(key, this.now),
      score: this.env.usage.score(key, this.now),
    };
  }

  column(
    group: string,
    label: string,
    index: SchemaIndex,
    table: Table,
    column: Column,
    order: number,
    tablesLabel: string,
  ): void {
    const key = columnKey(index.connection, table.namespace, table.name, column.name);
    const usage = this.usage(key);
    const trend = usage.trend ? `${TREND_ICON[usage.trend]} ` : '';
    const rankPart = usage.rank !== undefined ? `0${pad(usage.rank, 5)}` : `1${pad(order, 7)}`;
    const item: CompletionItem = {
      label,
      kind: CompletionItemKind.Field,
      detail: `${trend}${tablesLabel} · ${column.type}${column.nullable ? ' null' : ''}`,
      sortText: `${group}${rankPart}${label.toLowerCase()}`,
      data: [index.connection, table.namespace, table.name, column.name] satisfies ItemData,
    };
    this.setEdit(item, label);
    if (this.env.settings.usage.enabled) {
      item.command = { title: 'Record usage', command: RECORD_USAGE_COMMAND, arguments: [key] };
    }
    this.items.push(item);
    if (usage.rank !== undefined) {
      const previous = this.ranked.get(key);
      if (!previous || label.length < previous.label.length) {
        this.ranked.set(key, { label, filterText: label, score: usage.score });
      }
    }
  }

  table(label: string, index: SchemaIndex, table: Table, detail: string, insert = label): void {
    const key = tableKey(index.connection, table.namespace, table.name);
    const usage = this.usage(key);
    const trend = usage.trend ? `${TREND_ICON[usage.trend]} ` : '';
    const rankPart = usage.rank !== undefined ? `0${pad(usage.rank, 5)}` : '1';
    const item: CompletionItem = {
      label,
      kind: table.kind === 'view' ? CompletionItemKind.Interface : CompletionItemKind.Class,
      detail: `${trend}${detail}`,
      sortText: `a${rankPart}${label.toLowerCase()}`,
      data: [index.connection, table.namespace, table.name] satisfies ItemData,
    };
    this.setEdit(item, insert);
    if (this.env.settings.usage.enabled) {
      item.command = { title: 'Record usage', command: RECORD_USAGE_COMMAND, arguments: [key] };
    }
    this.items.push(item);
  }

  plain(label: string, kind: CompletionItemKind, detail: string, sortText: string, insert = label): void {
    const item: CompletionItem = { label, kind, detail, sortText };
    this.setEdit(item, insert);
    this.items.push(item);
  }

  resetItems(limit: number): void {
    const top = [...this.ranked.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    for (const [key, { label, filterText }] of top) {
      this.items.push({
        label: `↺ reset rank: ${label}`,
        kind: CompletionItemKind.Event,
        detail: 'forget how often it was picked',
        sortText: `zz${label}`,
        filterText,
        textEdit: this.keepEdit(),
        command: { title: 'Reset usage rank', command: RESET_USAGE_COMMAND, arguments: [key] },
      });
    }
  }
}

export function complete(
  context: QueryContext,
  document: TextDocument,
  cursor: number,
  env: CompletionEnv,
): CompletionList | null {
  let start = Math.min(Math.max(context.segmentStart, context.token.contentStart), cursor);
  let end = context.segmentEnd;
  let kinds = context.kinds;
  let scope = context.scope;
  const text = document.getText();

  if (context.rule) {
    const segment = ruleSegmentAt(context.token.value, cursor - context.token.contentStart);
    if (segment.kind === 'none') {
      return null;
    }
    start = context.token.contentStart + segment.start;
    end = context.token.contentStart + segment.end;
    if (segment.kind === 'column') {
      kinds = ['column'];
      scope = {
        ...emptyScope('query'),
        connection: segment.connection && env.store.config(segment.connection) ? segment.connection : undefined,
        tables: segment.table ? [{ name: segment.table, origin: 'self' }] : [],
      };
    }
  }
  if (cursor < start || cursor > context.token.contentEnd) {
    return null;
  }
  const tail = identifierTail.exec(text.slice(cursor, Math.min(end, context.token.contentEnd)))?.[0] ?? '';
  const builder = new ItemBuilder(env, document, start, cursor, cursor + tail.length);
  const typed = builder.typed;
  if (/\s/.test(typed) || typed.includes('->') || typed.includes('(')) {
    // `x as alias`, JSON paths, raw expressions
    return null;
  }
  let incomplete = false;
  for (const kind of kinds) {
    switch (kind) {
      case 'column':
        incomplete = completeColumns(builder, scope, typed, env) || incomplete;
        break;
      case 'table':
        incomplete = completeTables(builder, scope, typed, env, context.rule === true) || incomplete;
        break;
      case 'relation':
        completeRelations(builder, context, typed, env);
        break;
      case 'connection':
        for (const name of env.store.connectionNames()) {
          const config = env.store.config(name);
          builder.plain(
            name,
            CompletionItemKind.Module,
            `${config?.driver ?? ''} ${config?.database ?? ''}`.trim(),
            `a${name}`,
          );
        }
        break;
      case 'index':
        completeIndexes(builder, scope, env);
        break;
      case 'operator':
        if (context.operators && env.settings.completion.operators) {
          OPERATORS.forEach((op, i) => {
            builder.plain(op, CompletionItemKind.Operator, 'operator', `y${pad(i, 3)}`);
          });
        }
        break;
    }
  }
  if (builder.items.length === 0) {
    return incomplete ? { isIncomplete: true, items: [] } : null;
  }
  const list: CompletionList = { isIncomplete: incomplete, items: builder.items };
  if (env.editRangeDefault) {
    list.itemDefaults = { editRange: builder.defaultRange() };
  }
  return list;
}

function describeTables(resolved: ResolvedTable[], names: Set<string>): string {
  const labels = resolved.filter((r) => names.has(r.qualifier)).map((r) => r.qualifier);
  return labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ');
}

/** Returns whether the list depends on the typed text (server-side filtering). */
function completeColumns(builder: ItemBuilder, scope: Scope, typed: string, env: CompletionEnv): boolean {
  const { store, settings } = env;
  const resolved = resolveTables(store, scope);
  const index = indexFor(store, scope);
  const max = settings.completion.maxItems;
  const parts = typed.split('.');
  const lowerTyped = typed.toLowerCase();

  if (parts.length === 1) {
    // a: bare columns, one item per name (the tables that have it in the detail)
    const byName = new Map<string, { r: ResolvedTable; column: Column; order: number; tables: Set<string> }>();
    resolved.forEach((r, tableIndex) => {
      r.table.columns.forEach((column, ordinal) => {
        const lower = column.name.toLowerCase();
        const existing = byName.get(lower);
        if (existing) {
          existing.tables.add(r.qualifier);
        } else {
          byName.set(lower, { r, column, order: tableIndex * 10000 + ordinal, tables: new Set([r.qualifier]) });
        }
      });
    });
    for (const { r, column, order, tables } of byName.values()) {
      builder.column('a', column.name, r.index, r.table, column, order, describeTables(resolved, tables));
    }
    // b: qualified columns of the query's tables
    if (settings.completion.qualifiedColumns) {
      resolved.forEach((r, tableIndex) => {
        r.table.columns.forEach((column, ordinal) => {
          builder.column(
            'b',
            `${r.qualifier}.${column.name}`,
            r.index,
            r.table,
            column,
            tableIndex * 10000 + ordinal,
            r.qualifier,
          );
        });
      });
    }
    let incomplete = settings.completion.qualifiedColumns || settings.completion.databaseQualifiedColumns;
    // c: other tables' columns matching what is typed
    if (settings.completion.qualifiedColumns && index && lowerTyped.length > 0) {
      const context = new Set(resolved.map((r) => r.table));
      let budget = Math.max(0, max - builder.items.length);
      const matchedTables = index
        .defaultTables()
        .filter((t) => !context.has(t) && lowerTyped.length >= 2 && t.name.toLowerCase().startsWith(lowerTyped))
        .slice(0, 3);
      for (const table of matchedTables) {
        for (const [ordinal, column] of table.columns.slice(0, 80).entries()) {
          if (budget-- <= 0) {
            break;
          }
          builder.column(
            'c',
            `${index.reference(table)}.${column.name}`,
            index,
            table,
            column,
            ordinal,
            index.reference(table),
          );
        }
        context.add(table);
      }
      for (const ns of index.defaultNamespaces) {
        for (const entry of index.columnsIn(ns)) {
          if (budget <= 0) {
            break;
          }
          if (context.has(entry.table) || !matchesWord(entry.lower, lowerTyped)) {
            continue;
          }
          budget--;
          const ref = index.reference(entry.table);
          builder.column('c', `${ref}.${entry.column.name}`, index, entry.table, entry.column, 0, ref);
        }
      }
      incomplete = true;
    }
    // d: other databases / schemas
    if (settings.completion.databaseQualifiedColumns && index && lowerTyped.length >= 2) {
      let budget = Math.min(150, Math.max(0, max - builder.items.length));
      for (const { schema, ns } of otherNamespaces(store, index)) {
        for (const entry of schema.columnsIn(ns)) {
          if (budget <= 0) {
            break;
          }
          if (!entry.lower.startsWith(lowerTyped)) {
            continue;
          }
          budget--;
          const ref = `${ns}.${entry.table.name}`;
          builder.column('d', `${ref}.${entry.column.name}`, schema, entry.table, entry.column, 0, ref);
        }
      }
      incomplete = true;
    }
    if (settings.completion.resetItems && settings.usage.enabled) {
      builder.resetItems(10);
    }
    return incomplete;
  }

  // Qualified: `t1.na`, `users.na`, `db.users.na`
  const qualifier = parts.slice(0, -1).join('.');
  const lowerQualifier = qualifier.toLowerCase();
  const targets: Array<{ index: SchemaIndex; table: Table; label: string }> = [];
  for (const r of resolved) {
    if (
      r.qualifier.toLowerCase() === lowerQualifier ||
      (!r.ref.alias && r.table.name.toLowerCase() === lowerQualifier)
    ) {
      targets.push({ index: r.index, table: r.table, label: qualifier });
    }
  }
  if (targets.length === 0 && index) {
    const table = findTable(store, index, qualifier);
    if (table) {
      const owner = [index, ...store.siblings(index)].find((s) => s.findTable(qualifier) === table) ?? index;
      targets.push({ index: owner, table, label: qualifier });
    }
  }
  if (targets.length) {
    for (const target of targets.slice(0, 1)) {
      target.table.columns.forEach((column, ordinal) => {
        builder.column(
          'a',
          `${target.label}.${column.name}`,
          target.index,
          target.table,
          column,
          ordinal,
          target.label,
        );
      });
    }
    if (settings.completion.resetItems && settings.usage.enabled) {
      builder.resetItems(10);
    }
    return false;
  }
  // `db.` / `db.us`: tables of another namespace
  if (index && parts.length === 2) {
    const prefix = parts[1].toLowerCase();
    for (const { schema, ns } of [...ownNamespaces(index), ...otherNamespaces(store, index)]) {
      if (ns.toLowerCase() !== lowerQualifier) {
        continue;
      }
      for (const table of schema.tablesIn(ns)) {
        if (!table.name.toLowerCase().startsWith(prefix) && prefix) {
          continue;
        }
        builder.table(`${ns}.${table.name}`, schema, table, `${table.columns.length} columns`, `${ns}.${table.name}.`);
      }
    }
    return true;
  }
  return false;
}

/** `name` matches `na`, `user_name` matches `na` (word start), `created_at` matches `at`. */
function matchesWord(lowerName: string, lowerTyped: string): boolean {
  if (lowerName.startsWith(lowerTyped)) {
    return true;
  }
  const at = lowerName.indexOf(`_${lowerTyped}`);
  return at >= 0;
}

function ownNamespaces(index: SchemaIndex): Array<{ schema: SchemaIndex; ns: string }> {
  return index.namespaces.map((ns) => ({ schema: index, ns }));
}

/** Namespaces outside the connection's default ones, including sibling connections' databases. */
function otherNamespaces(store: SchemaStore, index: SchemaIndex): Array<{ schema: SchemaIndex; ns: string }> {
  const out: Array<{ schema: SchemaIndex; ns: string }> = [];
  const seen = new Set(index.defaultNamespaces.map((n) => n.toLowerCase()));
  for (const ns of index.namespaces) {
    if (!seen.has(ns.toLowerCase())) {
      seen.add(ns.toLowerCase());
      out.push({ schema: index, ns });
    }
  }
  for (const sibling of store.siblings(index)) {
    for (const ns of sibling.namespaces) {
      if (!seen.has(ns.toLowerCase())) {
        seen.add(ns.toLowerCase());
        out.push({ schema: sibling, ns });
      }
    }
  }
  return out;
}

function tableDetail(env: CompletionEnv, table: Table): string {
  const parts: string[] = [];
  const models = env.project?.modelsForTable(table.name) ?? [];
  if (models.length) {
    parts.push(models.map((m) => m.fqn.split('\\').pop()).join(', '));
  }
  parts.push(table.kind === 'view' ? 'view' : `${table.columns.length} columns`);
  if (table.rows !== undefined && table.rows > 0) {
    parts.push(`~${table.rows} rows`);
  }
  return parts.join(' · ');
}

function completeTables(builder: ItemBuilder, scope: Scope, typed: string, env: CompletionEnv, rule: boolean): boolean {
  const { store } = env;
  let index = indexFor(store, scope);
  let label = (ns: string, name: string) => `${ns}.${name}`;
  let typedTables = typed;
  if (rule) {
    // exists:connection.table
    const dot = typed.indexOf('.');
    const connection = dot > 0 ? typed.slice(0, dot) : '';
    if (connection && store.config(connection)) {
      index = store.get(connection);
      typedTables = typed.slice(dot + 1);
      label = (_ns, name) => `${connection}.${name}`;
      for (const table of index?.defaultTables() ?? []) {
        builder.table(`${connection}.${table.name}`, index as SchemaIndex, table, tableDetail(env, table));
      }
      return false;
    }
    for (const name of store.connectionNames()) {
      builder.plain(`${name}.`, CompletionItemKind.Module, 'connection', `zc${name}`);
    }
  }
  if (!index) {
    return true;
  }
  if (!typedTables.includes('.')) {
    for (const table of index.defaultTables()) {
      builder.table(table.name, index, table, tableDetail(env, table));
    }
    for (const { ns } of [...ownNamespaces(index), ...otherNamespaces(store, index)]) {
      if (index.defaultNamespaces.includes(ns)) {
        continue;
      }
      builder.plain(`${ns}.`, CompletionItemKind.Module, 'database', `z${ns}`);
    }
    return false;
  }
  const dot = typedTables.indexOf('.');
  const ns = typedTables.slice(0, dot).toLowerCase();
  for (const { schema, ns: name } of [...ownNamespaces(index), ...otherNamespaces(store, index)]) {
    if (name.toLowerCase() !== ns) {
      continue;
    }
    for (const table of schema.tablesIn(name)) {
      builder.table(label(name, table.name), schema, table, tableDetail(env, table));
    }
  }
  return false;
}

function completeRelations(builder: ItemBuilder, context: QueryContext, typed: string, env: CompletionEnv): void {
  let model = context.relationModel;
  const parts = typed.split('.');
  const prefix = parts.slice(0, -1);
  if (prefix.length && model && env.project) {
    model = env.project.relationPath(model, prefix.join('.')).model;
  }
  if (!model) {
    return;
  }
  for (const relation of model.relations.values()) {
    const label = [...prefix, relation.name].join('.');
    const related = relation.related?.split('\\').pop() ?? (relation.type === 'morphto' ? 'morph' : '?');
    builder.plain(label, CompletionItemKind.Method, `${relation.type} → ${related}`, `a${relation.name.toLowerCase()}`);
  }
}

function completeIndexes(builder: ItemBuilder, scope: Scope, env: CompletionEnv): void {
  for (const r of resolveTables(env.store, scope)) {
    for (const index of r.table.indexes) {
      builder.plain(
        index.name,
        CompletionItemKind.Reference,
        `${index.primary ? 'primary' : index.unique ? 'unique' : 'index'} (${index.columns.join(', ')})`,
        `a${index.name}`,
      );
    }
    for (const fk of r.table.foreignKeys) {
      builder.plain(
        fk.name,
        CompletionItemKind.Reference,
        `foreign (${fk.columns.join(', ')}) → ${fk.foreignTable}`,
        `b${fk.name}`,
      );
    }
  }
}

/** Markdown for completionItem/resolve and hover. */
export function columnMarkdown(index: SchemaIndex, table: Table, column: Column, usage?: UsageStore): string {
  const lines = [`**${table.name}.${column.name}** \`${column.type}\``, ''];
  const facts: string[] = [];
  facts.push(column.nullable ? 'nullable' : 'not null');
  if (column.key === 'PRI') {
    facts.push('primary key');
  } else if (column.key === 'UNI') {
    facts.push('unique');
  } else if (column.key === 'MUL') {
    facts.push('indexed');
  }
  if (column.default !== undefined && column.default !== null) {
    facts.push(`default \`${column.default}\``);
  }
  if (column.extra) {
    facts.push(column.extra);
  }
  lines.push(facts.join(' · '));
  for (const fk of table.foreignKeys) {
    const at = fk.columns.indexOf(column.name);
    if (at >= 0) {
      lines.push('', `→ \`${fk.foreignTable}.${fk.foreignColumns[at] ?? ''}\``);
    }
  }
  if (column.comment) {
    lines.push('', column.comment);
  }
  lines.push('', `_${index.connection} · ${table.namespace}_`);
  const key = columnKey(index.connection, table.namespace, table.name, column.name);
  const count = usage?.count(key) ?? 0;
  if (count > 0) {
    lines.push('', `picked ${count}×`);
  }
  return lines.join('\n');
}

export function tableMarkdown(index: SchemaIndex, table: Table, project?: LaravelProject): string {
  const lines = [`**${table.name}** ${table.kind === 'view' ? '(view)' : ''}`.trim(), ''];
  const facts = [`${table.columns.length} columns`];
  if (table.rows !== undefined) {
    facts.push(`~${table.rows} rows`);
  }
  facts.push(`${index.connection} · ${table.namespace}`);
  lines.push(facts.join(' · '));
  if (table.comment) {
    lines.push('', table.comment);
  }
  const models = project?.modelsForTable(table.name) ?? [];
  if (models.length) {
    lines.push('', `Model: ${models.map((m) => `\`${m.fqn}\``).join(', ')}`);
  }
  lines.push('', '```sql');
  for (const column of table.columns.slice(0, 40)) {
    const key = column.key === 'PRI' ? ' PK' : column.key === 'UNI' ? ' UNIQUE' : '';
    lines.push(`${column.name} ${column.type}${column.nullable ? ' NULL' : ''}${key}`);
  }
  if (table.columns.length > 40) {
    lines.push(`-- … ${table.columns.length - 40} more`);
  }
  lines.push('```');
  const indexes = table.indexes.filter((i) => !i.primary);
  if (indexes.length) {
    lines.push('', `Indexes: ${indexes.map((i) => `\`${i.name}\` (${i.columns.join(', ')})`).join(', ')}`);
  }
  return lines.join('\n');
}
