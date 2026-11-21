/** Hover on table and column strings: the schema of what they name. */
import type { Hover } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type QueryContext, ruleSegmentAt } from '../analysis/context.ts';
import { emptyScope, parseTableExpression } from '../analysis/scope.ts';
import type { SchemaStore } from '../db/schema.ts';
import type { LaravelProject } from '../laravel/project.ts';
import type { UsageStore } from '../usage.ts';
import { columnMarkdown, tableMarkdown } from './completion.ts';
import { findColumn, findTable, indexFor, resolveTables } from './resolve.ts';

export function hover(
  context: QueryContext,
  document: TextDocument,
  offset: number,
  store: SchemaStore,
  usage: UsageStore,
  project?: LaravelProject,
): Hover | null {
  const target = targetOf(context, offset);
  if (!target) {
    return null;
  }
  const { value, kinds, scope } = target;
  const range = { start: document.positionAt(target.start), end: document.positionAt(target.end) };
  for (const kind of kinds) {
    if (kind === 'table') {
      const index = indexFor(store, scope);
      const table = index ? findTable(store, index, parseTableExpression(value).name) : undefined;
      if (index && table) {
        return { contents: { kind: 'markdown', value: tableMarkdown(index, table, project) }, range };
      }
    }
    if (kind === 'column') {
      const resolved = resolveTables(store, scope);
      const match = findColumn(store, scope, resolved, value);
      if (match) {
        const index = match.resolved?.index ?? indexFor(store, scope);
        if (index) {
          return {
            contents: { kind: 'markdown', value: columnMarkdown(index, match.table, match.column, usage) },
            range,
          };
        }
      }
    }
  }
  return null;
}

export interface Target {
  value: string;
  start: number;
  end: number;
  kinds: QueryContext['kinds'];
  scope: QueryContext['scope'];
}

/** The part of the string a hover/definition at `offset` is about. */
export function targetOf(context: QueryContext, offset: number): Target | undefined {
  const token = context.token;
  if (context.rule) {
    const segment = ruleSegmentAt(token.value, offset - token.contentStart);
    if (segment.kind === 'none') {
      return undefined;
    }
    const value = token.value.slice(segment.start, segment.end).trim();
    if (segment.kind === 'table') {
      const dot = value.indexOf('.');
      return {
        value: dot > 0 ? value.slice(dot + 1) : value,
        start: token.contentStart + segment.start,
        end: token.contentStart + segment.end,
        kinds: ['table'],
        scope: { ...emptyScope('query'), connection: dot > 0 ? value.slice(0, dot) : undefined },
      };
    }
    return {
      value,
      start: token.contentStart + segment.start,
      end: token.contentStart + segment.end,
      kinds: ['column'],
      scope: {
        ...emptyScope('query'),
        connection: segment.connection,
        tables: segment.table ? [{ name: segment.table, origin: 'self' }] : [],
      },
    };
  }
  const start = Math.max(context.segmentStart, token.contentStart);
  return {
    value: token.value.slice(start - token.contentStart),
    start,
    end: token.contentEnd,
    kinds: context.kinds,
    scope: context.scope,
  };
}
