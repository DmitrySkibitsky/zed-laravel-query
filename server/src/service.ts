/**
 * Language features over documents: parses (and caches) PHP/Blade documents, finds the query
 * context at a position and dispatches to completion, hover, definition, diagnostics and code
 * actions. Independent of the LSP connection, so tests drive it directly.
 */
import type {
  CodeAction,
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  Position,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { contextAt, type QueryContext, scalarPropertyContext } from './analysis/context.ts';
import { Analyzer } from './analysis/scope.ts';
import {
  columnMarkdown,
  complete,
  type ItemData,
  REFRESH_SCHEMA_COMMAND,
  RESET_USAGE_COMMAND,
  STATUS_COMMAND,
  tableMarkdown,
} from './features/completion.ts';
import { definition } from './features/definition.ts';
import { diagnose } from './features/diagnostics.ts';
import { hover, targetOf } from './features/hover.ts';
import { findColumn, resolveTables } from './features/resolve.ts';
import { PhpDocument } from './php/document.ts';
import { columnKey, describeKey } from './usage.ts';
import type { Workspace } from './workspace.ts';

interface Parsed {
  version: number;
  doc: PhpDocument;
}

export function isBlade(uri: string): boolean {
  return uri.endsWith('.blade.php');
}

export class QueryService {
  private readonly parsed = new Map<string, Parsed>();
  private readonly synced = new Map<string, number>();
  insertReplace = false;
  editRangeDefault = false;

  parse(document: TextDocument): PhpDocument {
    const cached = this.parsed.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.doc;
    }
    const doc = new PhpDocument(document.getText(), {
      blade: isBlade(document.uri) || document.languageId === 'blade',
    });
    this.parsed.set(document.uri, { version: document.version, doc });
    return doc;
  }

  forget(uri: string, workspace?: Workspace): void {
    this.parsed.delete(uri);
    if (this.synced.delete(uri) && workspace && uri.startsWith('file:')) {
      workspace.project.dropOverride(URI.parse(uri).fsPath);
    }
  }

  /** The context of the string at `offset`, re-parsing with a closed quote while one is being typed. */
  contextAt(document: TextDocument, offset: number, workspace: Workspace): QueryContext | undefined {
    let doc = this.parse(document);
    let index = doc.stringIndexAt(offset);
    if (index < 0) {
      return undefined;
    }
    const token = doc.stringAt(index);
    if (token && !token.quote.startsWith('<<<')) {
      const text = doc.text;
      const lineEnd = text.indexOf('\n', offset);
      const unterminatedHere = !token.closed || (lineEnd >= 0 && lineEnd < token.contentEnd);
      if (unterminatedHere) {
        // `->where('na` while the closing quote is not typed yet: the string would swallow the
        // rest of the file. Close it at the end of the line.
        const end = lineEnd < 0 ? text.length : lineEnd;
        const lineRest = text.slice(offset, end);
        const close = /[)\],;]/.exec(lineRest);
        const at = close ? offset + close.index : end;
        doc = new PhpDocument(text.slice(0, at) + token.quote + text.slice(at), { startInPhp: isBlade(document.uri) });
        index = doc.stringIndexAt(offset);
        if (index < 0) {
          return undefined;
        }
      }
    }
    this.syncOpenClass(document, workspace);
    const analyzer = new Analyzer(doc, workspace.project);
    return contextAt(analyzer, index) ?? scalarPropertyContext(analyzer, index);
  }

  /** Unsaved changes of an open model count (new relations, `$table`). */
  private syncOpenClass(document: TextDocument, workspace: Workspace): void {
    if (isBlade(document.uri) || !document.uri.startsWith('file:')) {
      return;
    }
    if (this.synced.get(document.uri) === document.version) {
      return;
    }
    this.synced.set(document.uri, document.version);
    const doc = this.parse(document);
    if (doc.classes.some((c) => c.extends)) {
      workspace.project.updateClassFromText(URI.parse(document.uri).fsPath, document.getText(), doc);
    }
  }

  complete(document: TextDocument, position: Position, workspace: Workspace): CompletionList | null {
    const offset = document.offsetAt(position);
    const context = this.contextAt(document, offset, workspace);
    if (!context) {
      return null;
    }
    return complete(context, document, offset, {
      store: workspace.store,
      usage: workspace.usage,
      settings: workspace.settings,
      project: workspace.project,
      insertReplace: this.insertReplace,
      editRangeDefault: this.editRangeDefault,
    });
  }

  resolveCompletion(item: CompletionItem, workspace: Workspace): CompletionItem {
    const data = item.data as ItemData | undefined;
    if (!Array.isArray(data) || data.length < 3) {
      return item;
    }
    const [connectionName, namespace, tableName, columnName] = data;
    const index = workspace.store.get(connectionName);
    const table = index?.tablesIn(namespace).find((t) => t.name === tableName);
    if (!index || !table) {
      return item;
    }
    const column = columnName ? index.column(table, columnName) : undefined;
    item.documentation = {
      kind: 'markdown',
      value: column
        ? columnMarkdown(index, table, column, workspace.usage)
        : tableMarkdown(index, table, workspace.project),
    };
    return item;
  }

  hover(document: TextDocument, position: Position, workspace: Workspace): Hover | null {
    const offset = document.offsetAt(position);
    const context = this.contextAt(document, offset, workspace);
    return context ? hover(context, document, offset, workspace.store, workspace.usage, workspace.project) : null;
  }

  definition(document: TextDocument, position: Position, workspace: Workspace): Location[] | null {
    const offset = document.offsetAt(position);
    const context = this.contextAt(document, offset, workspace);
    return context ? definition(context, offset, workspace.store, workspace.project) : null;
  }

  diagnostics(document: TextDocument, workspace: Workspace): Diagnostic[] {
    this.syncOpenClass(document, workspace);
    const analyzer = new Analyzer(this.parse(document), workspace.project);
    return diagnose(analyzer, document, workspace.store, workspace.settings);
  }

  /** Refresh / reset / status actions on query strings (Zed has no LSP command palette). */
  codeActions(
    document: TextDocument,
    position: Position,
    workspace: Workspace,
    diagnostics: Diagnostic[],
  ): CodeAction[] {
    const offset = document.offsetAt(position);
    const context = this.contextAt(document, offset, workspace);
    const fromDiagnostic = diagnostics.some((d) => d.source === 'laravel-query');
    if (!context && !fromDiagnostic) {
      return [];
    }
    const actions: CodeAction[] = [];
    if (context) {
      const target = targetOf(context, offset);
      if (target && context.kinds.includes('column')) {
        const match = findColumn(
          workspace.store,
          target.scope,
          resolveTables(workspace.store, target.scope),
          target.value,
        );
        const connection = match?.resolved?.index.connection ?? workspace.store.defaultConnection;
        if (match) {
          const key = columnKey(connection, match.table.namespace, match.table.name, match.column.name);
          if (workspace.usage.has(key)) {
            actions.push({
              title: `Laravel Query: reset usage rank of ${describeKey(key)}`,
              kind: 'quickfix',
              command: { title: 'Reset usage rank', command: RESET_USAGE_COMMAND, arguments: [key] },
            });
          }
        }
      }
    }
    actions.push(
      {
        title: 'Laravel Query: refresh database schema',
        kind: fromDiagnostic ? 'quickfix' : 'source',
        command: { title: 'Refresh schema', command: REFRESH_SCHEMA_COMMAND, arguments: [] },
      },
      {
        title: 'Laravel Query: reset usage ranks of all columns',
        kind: 'source',
        command: { title: 'Reset all usage ranks', command: RESET_USAGE_COMMAND, arguments: [] },
      },
      {
        title: 'Laravel Query: show connections and schema status',
        kind: 'source',
        command: { title: 'Status', command: STATUS_COMMAND, arguments: [] },
      },
    );
    return actions;
  }
}
