/**
 * Unknown tables and columns in query builder strings. Only reported when the schema of the
 * connection is loaded and every table of the query resolved: a column of an unknown table, a
 * subquery alias or a raw expression is never flagged.
 */
import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { contextAt, type QueryContext, scalarPropertyContext } from '../analysis/context.ts';
import type { Analyzer } from '../analysis/scope.ts';
import { parseTableExpression } from '../analysis/scope.ts';
import type { SchemaStore } from '../db/schema.ts';
import type { Settings } from '../settings.ts';
import { type Target, targetOf } from './hover.ts';
import { columnPart, findColumn, findTable, indexFor, resolveTables } from './resolve.ts';

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export const DIAGNOSTIC_SOURCE = 'laravel-query';

export function diagnose(
  analyzer: Analyzer,
  document: TextDocument,
  store: SchemaStore,
  settings: Settings,
): Diagnostic[] {
  if (!settings.diagnostics.enabled) {
    return [];
  }
  const doc = analyzer.doc;
  const out: Diagnostic[] = [];
  const severity = SEVERITY[settings.diagnostics.severity];
  for (let i = 0; i < doc.length; i++) {
    const token = doc.stringAt(i);
    if (!token || token.interpolated || !token.value || token.quote.startsWith('<<<')) {
      continue;
    }
    const context = contextAt(analyzer, i) ?? scalarPropertyContext(analyzer, i);
    if (!context || context.newColumn) {
      continue;
    }
    for (const target of targetsOf(context)) {
      const range = { start: document.positionAt(target.start), end: document.positionAt(target.end) };
      const kind = target.kinds[0];
      if (kind === 'table' && settings.diagnostics.unknownTables) {
        const index = indexFor(store, target.scope);
        if (!index) {
          continue;
        }
        const name = parseTableExpression(target.value).name;
        if (!name || /[\s(]/.test(name)) {
          continue;
        }
        const dot = name.indexOf('.');
        // `otherdb.table` for a database that was never read: nothing to check against.
        if (
          dot > 0 &&
          !index.hasNamespace(name.slice(0, dot)) &&
          !store.siblings(index).some((s) => s.hasNamespace(name.slice(0, dot)))
        ) {
          continue;
        }
        if (!findTable(store, index, name)) {
          out.push({
            range,
            severity,
            source: DIAGNOSTIC_SOURCE,
            code: 'unknown-table',
            message: `Unknown table '${name}' (connection ${index.connection})`,
          });
        }
        continue;
      }
      if (kind === 'column' && settings.diagnostics.unknownColumns) {
        const scope = target.scope;
        if (scope.collection) {
          continue;
        }
        const name = columnPart(target.value);
        if (!name) {
          continue;
        }
        const parts = name.split('.');
        const column = parts[parts.length - 1].toLowerCase();
        const qualifierText = parts.slice(0, -1).join('.');
        const qualifier = qualifierText.toLowerCase();
        if (
          scope.aliases.has(column) ||
          (qualifier && scope.opaque.has(qualifier)) ||
          (!qualifier && scope.opaque.size > 0)
        ) {
          continue;
        }
        const resolved = resolveTables(store, scope);
        if (qualifier) {
          // `table.column` can be checked whenever `table` is a table of the query or of the
          // database — also in queries whose root did not resolve.
          const known = resolved.some(
            (r) =>
              r.qualifier.toLowerCase() === qualifier || (!r.ref.alias && r.table.name.toLowerCase() === qualifier),
          );
          const index = indexFor(store, scope);
          if (!known && !(index && findTable(store, index, qualifierText))) {
            // Neither a table of the query nor a known table: maybe an alias from raw SQL.
            continue;
          }
        } else {
          // A bare column needs every table of the query: not for inferred queries or guessed models.
          const uncertain =
            scope.inferred ||
            scope.tables.length === 0 ||
            scope.tables.some((t) => t.origin === 'guess' || t.origin === 'mentioned');
          const unique = scope.tables.filter(
            (t, idx, all) => all.findIndex((o) => o.name === t.name && o.alias === t.alias) === idx,
          );
          if (uncertain || resolved.length !== unique.length) {
            continue;
          }
        }
        if (!findColumn(store, scope, resolved, name)) {
          const tables = resolved.map((r) => r.qualifier).join(', ');
          out.push(
            column
              ? {
                  range,
                  severity,
                  source: DIAGNOSTIC_SOURCE,
                  code: 'unknown-column',
                  message: `Unknown column '${name}' in ${qualifier ? `'${qualifierText}'` : tables}`,
                }
              : {
                  range,
                  severity,
                  source: DIAGNOSTIC_SOURCE,
                  code: 'missing-column',
                  message: `Column name missing after '${qualifierText}.'`,
                },
          );
        }
      }
    }
  }
  return out;
}

/** What to check in a string: the whole value, or each table and column of its validation rules. */
function targetsOf(context: QueryContext): Target[] {
  const token = context.token;
  if (!context.rule) {
    const target = targetOf(context, token.contentEnd);
    return target ? [target] : [];
  }
  const targets: Target[] = [];
  for (const match of token.value.matchAll(/(?:^|\|)\s*(?:exists|unique):([^,|]*)(,[^,|]*)?/gi)) {
    const tableAt = (match.index ?? 0) + match[0].indexOf(':') + 1;
    for (const at of [tableAt, match[2] ? tableAt + match[1].length + 1 : -1]) {
      const target = at >= 0 ? targetOf(context, token.contentStart + at) : undefined;
      if (target?.value) {
        targets.push(target);
      }
    }
  }
  return targets;
}
