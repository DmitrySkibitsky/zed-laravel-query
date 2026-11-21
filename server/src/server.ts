/**
 * laravel-query language server: database-aware completion, hover, go to definition and
 * diagnostics in Laravel query builder strings. Runs over stdio; started by the Zed extension
 * (see ../../src/lib.rs). Bundled as CommonJS (.cjs) so it runs regardless of the nearest
 * package.json "type".
 */
import {
  type CodeActionParams,
  createConnection,
  type InitializeParams,
  type InitializeResult,
  MessageType,
  ProposedFeatures,
  ShowMessageNotification,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  RECORD_USAGE_COMMAND,
  REFRESH_SCHEMA_COMMAND,
  RESET_USAGE_COMMAND,
  STATUS_COMMAND,
} from './features/completion.ts';
import { QueryService } from './service.ts';
import { parseSettings, type Settings } from './settings.ts';
import { describeKey } from './usage.ts';
import { Workspace } from './workspace.ts';

/** Replaced by esbuild with server/package.json "version"; unset when run from source (tests). */
declare const LARAVEL_QUERY_VERSION: string | undefined;
const SERVER_VERSION = typeof LARAVEL_QUERY_VERSION === 'string' ? LARAVEL_QUERY_VERSION : 'dev';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const service = new QueryService();

let settings: Settings = parseSettings(undefined);
let roots: string[] = [];
const workspaces = new Map<string, Workspace>();
let looseWorkspace: Workspace | undefined;
let workspaceFolderEvents = false;
let lastCompletionWorkspace: Workspace | undefined;
const diagnosticTimers = new Map<string, NodeJS.Timeout>();

const log = (message: string) => connection.console.log(message);

/** A message Zed shows as a prompt that does not wait for an answer. */
function notify(message: string, type: MessageType = MessageType.Info): void {
  void connection.sendNotification(ShowMessageNotification.type, { type, message });
}

function createWorkspace(root: string): Workspace {
  return new Workspace(root, settings, {
    log,
    onSchemaChange: () => {
      for (const document of documents.all()) {
        scheduleDiagnostics(document, 50);
      }
    },
  });
}

function workspaceFor(uri: string): Workspace {
  const file = URI.parse(uri).fsPath;
  const root = roots
    .filter((r) => file === r || file.startsWith(r.endsWith('/') ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) {
    looseWorkspace ??= createWorkspace(process.cwd());
    return looseWorkspace;
  }
  let workspace = workspaces.get(root);
  if (!workspace) {
    workspace = createWorkspace(root);
    workspaces.set(root, workspace);
  }
  return workspace;
}

function allWorkspaces(): Workspace[] {
  return [...workspaces.values(), ...(looseWorkspace ? [looseWorkspace] : [])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function withDocument<P extends { textDocument: { uri: string } }, R>(
  handler: (document: TextDocument, params: P, workspace: Workspace) => R,
  fallback: R,
) {
  return (params: P): R => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return fallback;
    }
    try {
      return handler(document, params, workspaceFor(document.uri));
    } catch (error) {
      connection.console.error(errorMessage(error));
      return fallback;
    }
  };
}

function scheduleDiagnostics(document: TextDocument, delay = 350): void {
  const previous = diagnosticTimers.get(document.uri);
  if (previous) {
    clearTimeout(previous);
  }
  diagnosticTimers.set(
    document.uri,
    setTimeout(() => {
      diagnosticTimers.delete(document.uri);
      const current = documents.get(document.uri);
      if (!current) {
        return;
      }
      try {
        const diagnostics = service.diagnostics(current, workspaceFor(current.uri));
        void connection.sendDiagnostics({ uri: current.uri, version: current.version, diagnostics });
      } catch (error) {
        connection.console.error(errorMessage(error));
      }
    }, delay),
  );
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = parseSettings(params.initializationOptions);
  workspaceFolderEvents = params.capabilities.workspace?.workspaceFolders === true;
  const completion = params.capabilities.textDocument?.completion;
  service.insertReplace = completion?.completionItem?.insertReplaceSupport === true;
  service.editRangeDefault = completion?.completionList?.itemDefaults?.includes('editRange') === true;
  const folders = params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : []);
  roots = folders.map((uri) => URI.parse(uri).fsPath);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["'", '"', '.', ',', ':', '|'], resolveProvider: true },
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: { codeActionKinds: ['quickfix', 'source'] },
      executeCommandProvider: {
        commands: [RECORD_USAGE_COMMAND, RESET_USAGE_COMMAND, REFRESH_SCHEMA_COMMAND, STATUS_COMMAND],
      },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'laravel-query', version: SERVER_VERSION },
  };
});

connection.onInitialized(() => {
  for (const root of roots) {
    workspaceFor(URI.file(root).toString());
  }
  if (!workspaceFolderEvents) {
    return;
  }
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const removed of event.removed) {
      const root = URI.parse(removed.uri).fsPath;
      roots = roots.filter((r) => r !== root);
      workspaces.get(root)?.dispose();
      workspaces.delete(root);
    }
    roots.push(...event.added.map((f) => URI.parse(f.uri).fsPath));
  });
});

connection.onDidChangeConfiguration((change) => {
  if (change.settings === null || change.settings === undefined) {
    return;
  }
  const next = parseSettings(change.settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) {
    return;
  }
  settings = next;
  for (const workspace of allWorkspaces()) {
    workspace.updateSettings(settings);
  }
  for (const document of documents.all()) {
    scheduleDiagnostics(document, 50);
  }
});

documents.onDidOpen((event) => scheduleDiagnostics(event.document, 50));
documents.onDidChangeContent((event) => scheduleDiagnostics(event.document));
documents.onDidClose((event) => {
  service.forget(event.document.uri, workspaceFor(event.document.uri));
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion(
  withDocument((doc, params, workspace) => {
    lastCompletionWorkspace = workspace;
    return service.complete(doc, params.position, workspace);
  }, null),
);
connection.onCompletionResolve((item) => {
  try {
    const workspace = lastCompletionWorkspace ?? allWorkspaces()[0];
    return workspace ? service.resolveCompletion(item, workspace) : item;
  } catch (error) {
    connection.console.error(errorMessage(error));
    return item;
  }
});
connection.onHover(withDocument((doc, params, workspace) => service.hover(doc, params.position, workspace), null));
connection.onDefinition(
  withDocument((doc, params, workspace) => service.definition(doc, params.position, workspace), null),
);
connection.onCodeAction(
  withDocument(
    (doc, params: CodeActionParams, workspace) =>
      service.codeActions(doc, params.range.start, workspace, params.context.diagnostics),
    [],
  ),
);

connection.onExecuteCommand(async (params) => {
  const args = params.arguments ?? [];
  const targets = allWorkspaces();
  try {
    switch (params.command) {
      case RECORD_USAGE_COMMAND: {
        const key = typeof args[0] === 'string' ? args[0] : undefined;
        // Recorded in the project the completion came from.
        if (key) {
          (lastCompletionWorkspace ?? targets[0])?.usage.record(key);
        }
        return null;
      }
      case RESET_USAGE_COMMAND: {
        const key = typeof args[0] === 'string' ? args[0] : undefined;
        let removed = 0;
        for (const workspace of targets) {
          removed += workspace.usage.reset(key);
        }
        notify(
          key
            ? `Laravel Query: usage rank of ${describeKey(key)} reset`
            : `Laravel Query: ${removed} usage ranks reset`,
        );
        return null;
      }
      case REFRESH_SCHEMA_COMMAND: {
        const connectionName = typeof args[0] === 'string' ? args[0] : undefined;
        const results = await Promise.all(targets.map((w) => w.refresh(connectionName)));
        notify(`Laravel Query: schema refreshed — ${results.join(' | ')}`);
        return null;
      }
      case STATUS_COMMAND: {
        notify(targets.map((w) => w.status()).join('\n\n') || 'Laravel Query: no project');
        return null;
      }
      default:
        return null;
    }
  } catch (error) {
    connection.console.error(errorMessage(error));
    notify(`Laravel Query: ${error instanceof Error ? error.message : String(error)}`, MessageType.Error);
    return null;
  }
});

connection.onShutdown(() => {
  for (const workspace of allWorkspaces()) {
    workspace.dispose();
  }
});

documents.listen(connection);
connection.listen();
