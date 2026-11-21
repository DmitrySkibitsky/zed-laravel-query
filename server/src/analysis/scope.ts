/**
 * Which tables a query builder expression works on. Follows the chain back to its root (DB
 * facade, model class, `$this` in a model, a variable) and forward through the joins; resolves
 * variables through closure parameters (nested where, join, relation, subquery closures), typed
 * parameters, `@var`/`@param` docs and assignments.
 */

import { tableForModel } from '../laravel/inflector.ts';
import { closureKind, TERMINAL_METHODS } from '../laravel/methods.ts';
import type { LaravelProject, ModelInfo } from '../laravel/project.ts';
import { type FunctionDecl, literalValue, type Param, type PhpDocument } from '../php/document.ts';
import { type CallSite, type Chain, callArgs, chainEndingAt, type Segment, segmentsAfter, siteOf } from './chain.ts';

export type TableOrigin =
  | 'self'
  | 'model'
  | 'table'
  | 'join'
  | 'relation'
  | 'pivot'
  | 'sub'
  | 'outer'
  | 'guess'
  /** Named as a qualifier in the query's strings (`'users.id'`) of an inferred query. */
  | 'mentioned';

export interface TableRef {
  /** As written: `users`, `demo1.users`. */
  name: string;
  alias?: string;
  /** Connection when it differs from the scope's. */
  connection?: string;
  origin: TableOrigin;
  model?: ModelInfo;
}

export type ScopeKind = 'db' | 'schema' | 'query' | 'model' | 'blueprint' | 'test' | 'rule' | 'factory' | 'unknown';

export interface Scope {
  kind: ScopeKind;
  connection?: string;
  tables: TableRef[];
  model?: ModelInfo;
  /** `$this` inside the model class itself (relation definitions, scopes). */
  self?: boolean;
  blueprintMode?: 'create' | 'table';
  /** Pivot table of a belongsToMany relation. */
  pivot?: TableRef;
  /** Names introduced by `select('x as y')`, `withCount('posts')`…: valid in later clauses. */
  aliases: Set<string>;
  /** Aliases of subqueries (`joinSub`, `fromSub`) whose columns are unknown. */
  opaque: Set<string>;
  /** After `get()`, `all()`, `chunk()`: a collection or rows, not a builder. */
  collection?: boolean;
  /** The root did not resolve; builder-only methods in the chain tell it is a query. */
  inferred?: boolean;
}

export function emptyScope(kind: ScopeKind = 'unknown'): Scope {
  return { kind, tables: [], aliases: new Set(), opaque: new Set() };
}

export function cloneScope(scope: Scope): Scope {
  return {
    ...scope,
    tables: [...scope.tables],
    aliases: new Set(scope.aliases),
    opaque: new Set(scope.opaque),
  };
}

/** `users as u` / `users u`? Laravel only knows `as`. */
export function parseTableExpression(value: string): { name: string; alias?: string } {
  const match = /^\s*([^\s]+?)\s+as\s+([^\s]+)\s*$/i.exec(value);
  if (match) {
    return { name: match[1], alias: match[2] };
  }
  return { name: value.trim() };
}

const BUILDER_TYPES =
  /(^|\\|\|)(Builder|EloquentBuilder|QueryBuilder|JoinClause|Relation|HasMany|HasOne|BelongsTo|BelongsToMany|MorphMany|MorphOne|MorphTo|MorphToMany|HasManyThrough|HasOneThrough)(<|$|\|)/;
const BLUEPRINT_TYPE = /(^|\\)Blueprint$/;
/** Base classes of a project's own builders (`class GridQueryBuilder extends Builder`). */
const BUILDER_BASES = new Set(
  [
    'Illuminate\\Database\\Query\\Builder',
    'Illuminate\\Database\\Eloquent\\Builder',
    'Illuminate\\Database\\Eloquent\\Relations\\Relation',
  ].map((c) => c.toLowerCase()),
);
const JOIN_METHODS = new Set([
  'join',
  'leftjoin',
  'rightjoin',
  'crossjoin',
  'joinwhere',
  'leftjoinwhere',
  'rightjoinwhere',
  'straightjoin',
]);
const SUB_ALIAS_METHODS = new Map([
  ['joinsub', 1],
  ['leftjoinsub', 1],
  ['rightjoinsub', 1],
  ['fromsub', 1],
  ['joinlateral', 1],
  ['leftjoinlateral', 1],
]);
/** Methods only query builders have (collections and other fluent objects do not). */
export const BUILDER_EVIDENCE = new Set(
  [
    'join',
    'leftJoin',
    'rightJoin',
    'crossJoin',
    'joinWhere',
    'leftJoinWhere',
    'joinSub',
    'leftJoinSub',
    'rightJoinSub',
    'from',
    'fromSub',
    'whereRaw',
    'orWhereRaw',
    'selectRaw',
    'havingRaw',
    'orderByRaw',
    'groupByRaw',
    'toSql',
    'toRawSql',
    'newQuery',
    'newModelQuery',
    'newQueryWithoutScopes',
    'newQueryWithoutScope',
    'newQueryWithoutRelationships',
    'getQuery',
    'toBase',
    'whereHas',
    'orWhereHas',
    'whereDoesntHave',
    'withCount',
    'whereExists',
    'whereColumn',
    'orWhereColumn',
    'lockForUpdate',
    'sharedLock',
    'simplePaginate',
    'cursorPaginate',
    'chunkById',
    'addSelect',
    'selectSub',
    'orderBy',
    'orderByDesc',
    'latest',
    'oldest',
    'whereDate',
    'whereYear',
    'whereMonth',
    'whereBetweenColumns',
    'whereLike',
    'whereFullText',
  ].map((m) => m.toLowerCase()),
);

const QUALIFIER = /^\s*([A-Za-z_][\w$]*)\.(?:[A-Za-z_][\w]*|\*)/;

const AGGREGATE_ALIASES: Record<string, string> = {
  withcount: 'count',
  withsum: 'sum',
  withmax: 'max',
  withmin: 'min',
  withavg: 'avg',
  withexists: 'exists',
};

export class Analyzer {
  readonly doc: PhpDocument;
  readonly project: LaravelProject | undefined;
  private readonly memo = new Map<string, Scope>();
  private depth = 0;

  constructor(doc: PhpDocument, project: LaravelProject | undefined) {
    this.doc = doc;
    this.project = project;
  }

  /** Literal string value of an argument range (one string token). */
  literalArg(range: [number, number] | undefined): string | undefined {
    if (!range || range[0] !== range[1]) {
      return undefined;
    }
    return literalValue(this.doc.tok(range[0]));
  }

  /** `User::class` → its model; a table string → nothing. */
  classArg(range: [number, number] | undefined): string | undefined {
    if (!range) {
      return undefined;
    }
    const [a, b, c] = [this.doc.tok(range[0]), this.doc.tok(range[0] + 1), this.doc.tok(range[0] + 2)];
    if (a?.type === 'ident' && b?.type === 'op' && b.value === '::' && c?.value.toLowerCase() === 'class') {
      return this.resolveClassName(a.value, range[0]);
    }
    return undefined;
  }

  resolveClassName(name: string, at: number): string {
    const lower = name.toLowerCase();
    if (lower === 'static' || lower === 'self') {
      return this.doc.enclosingClass(at)?.fqn ?? name;
    }
    if (lower === 'parent') {
      return this.doc.enclosingClass(at)?.extends ?? name;
    }
    return this.doc.resolveClass(name);
  }

  model(fqn: string | undefined): ModelInfo | undefined {
    return fqn ? this.project?.model(fqn) : undefined;
  }

  modelScope(model: ModelInfo, origin: TableOrigin = 'model'): Scope {
    const scope = emptyScope('model');
    scope.model = model;
    scope.connection = model.connection;
    scope.tables.push({ name: model.table, origin, model });
    return scope;
  }

  /** Scope of the expression ending at token `end` (a receiver). */
  scopeOfExpression(end: number): Scope {
    const key = `e${end}`;
    const cached = this.memo.get(key);
    if (cached) {
      return cached;
    }
    if (this.depth > 24) {
      return emptyScope();
    }
    this.depth++;
    try {
      const scope = this.evaluate(chainEndingAt(this.doc, end));
      this.memo.set(key, scope);
      return scope;
    } finally {
      this.depth--;
    }
  }

  /** Scope of the receiver of a call site (`X` in `X->where(` / `X::where(`). */
  scopeOfReceiver(site: CallSite): Scope {
    if (site.kind === 'method') {
      return this.scopeOfExpression(site.receiverEnd);
    }
    if (site.kind === 'static') {
      const receiver = this.doc.tok(site.receiverEnd);
      if (receiver?.type === 'var') {
        return this.scopeOfVariable(receiver.value, site.receiverEnd);
      }
      if (receiver?.type === 'ident') {
        return this.scopeOfClass(receiver.value, site.receiverEnd);
      }
    }
    if (site.kind === 'function') {
      return emptyScope(/^assertDatabase|^assert(Not)?SoftDeleted$/i.test(site.name) ? 'test' : 'unknown');
    }
    return emptyScope();
  }

  evaluate(chain: Chain): Scope {
    let scope: Scope;
    const root = chain.root;
    let segments = chain.segments;
    // The service container: app(User::class), resolve(User::class), app()->make(User::class),
    // App::make(User::class) give an instance of the class.
    const container = this.containerClass(chain);
    if (container) {
      scope = this.scopeOfClass(container.className, container.tok);
      segments = segments.slice(container.skip);
      for (const segment of segments) {
        scope = this.applySegment(scope, segment);
      }
      if (
        scope.kind === 'unknown' &&
        segments.some((s) => s.open !== undefined && BUILDER_EVIDENCE.has(s.name.toLowerCase()))
      ) {
        scope = this.inferQuery(segments);
      }
      return scope;
    }
    switch (root.kind) {
      case 'class': {
        scope = this.scopeOfClass(root.name, root.tok);
        break;
      }
      case 'var':
        scope = this.scopeOfVariable(root.name, root.tok);
        break;
      case 'new': {
        const model = this.model(this.resolveClassName(root.name, root.tok));
        scope = model ? this.modelScope(model) : emptyScope();
        break;
      }
      case 'function':
        scope = this.scopeOfFunctionRoot(root.name, root.open, root.close);
        break;
      default:
        scope = emptyScope();
    }
    for (const segment of segments) {
      scope = this.applySegment(scope, segment);
    }
    if (
      scope.kind === 'unknown' &&
      segments.some((s) => s.open !== undefined && BUILDER_EVIDENCE.has(s.name.toLowerCase()))
    ) {
      scope = this.inferQuery(segments);
    }
    segments = [];
    return scope;
  }

  /** A query of an unresolvable root: tables from its joins and from qualifiers in its strings. */
  inferQuery(segments: Segment[], into?: Scope): Scope {
    let scope = into ?? { ...emptyScope('query'), inferred: true };
    for (const segment of segments) {
      if (segment.open === undefined || segment.close === undefined) {
        continue;
      }
      scope = this.applyBuilderSegment(
        scope,
        segment.name.toLowerCase(),
        segment,
        callArgs(this.doc, segment.open, segment.close),
      );
      this.collectMentioned(segment.open, segment.close, scope);
    }
    return dedupeTables(scope);
  }

  /** `'users.id'` in arguments: `users` is probably a table of the query. */
  collectMentioned(open: number, close: number, scope: Scope): void {
    const known = new Set(scope.tables.flatMap((t) => [t.name.toLowerCase(), t.alias?.toLowerCase() ?? '']));
    for (let i = open + 1; i < close; i++) {
      const value = literalValue(this.doc.tok(i));
      if (!value) {
        continue;
      }
      const match = QUALIFIER.exec(value);
      if (match && !known.has(match[1].toLowerCase())) {
        known.add(match[1].toLowerCase());
        scope.tables.push({ name: match[1], origin: 'mentioned' });
      }
    }
  }

  /** The class a container call resolves, and how many chain segments that call takes. */
  private containerClass(chain: Chain): { className: string; tok: number; skip: number } | undefined {
    const root = chain.root;
    const classOf = (open: number | undefined, close: number | undefined) => {
      if (open === undefined || close === undefined) {
        return undefined;
      }
      const first = callArgs(this.doc, open, close)[0];
      const fqn = this.classArg(first);
      return fqn && first ? { className: `\\${fqn}`, tok: first[0] } : undefined;
    };
    if (root.kind === 'function' && /^\\?(app|resolve)$/i.test(root.name)) {
      const direct = classOf(root.open, root.close);
      if (direct) {
        return { ...direct, skip: 0 };
      }
      const make = chain.segments[0];
      if (make && /^(make|makeWith|get)$/i.test(make.name)) {
        const resolved = classOf(make.open, make.close);
        return resolved ? { ...resolved, skip: 1 } : undefined;
      }
    }
    if (root.kind === 'class' && /(^|\\)(App|Container)$/.test(root.name)) {
      const make = chain.segments[0];
      if (make?.isStatic && /^(make|makeWith|get)$/i.test(make.name)) {
        const resolved = classOf(make.open, make.close);
        return resolved ? { ...resolved, skip: 1 } : undefined;
      }
    }
    return undefined;
  }

  private scopeOfFunctionRoot(name: string, open: number, close: number): Scope {
    const lower = name.toLowerCase().replace(/^\\/, '');
    // tap($query, fn) / with($query) return their first argument
    if ((lower === 'tap' || lower === 'with') && open >= 0) {
      const first = callArgs(this.doc, open, close)[0];
      if (first) {
        return this.scopeOfExpression(first[1]);
      }
    }
    return emptyScope();
  }

  scopeOfClass(name: string, at: number): Scope {
    const fqn = this.resolveClassName(name, at);
    const basename = (fqn.split('\\').pop() ?? fqn).toLowerCase();
    const lower = fqn.toLowerCase();
    if (lower === 'illuminate\\support\\facades\\db' || basename === 'db') {
      return emptyScope('db');
    }
    if (lower === 'illuminate\\support\\facades\\schema' || basename === 'schema') {
      return emptyScope('schema');
    }
    if (lower === 'illuminate\\validation\\rule' || basename === 'rule') {
      return emptyScope('rule');
    }
    const model = this.model(fqn);
    if (model) {
      return this.modelScope(model);
    }
    if (this.project?.isFactory(fqn)) {
      const factoryModel = this.project.factoryModel(fqn);
      if (factoryModel) {
        const scope = this.modelScope(factoryModel);
        scope.kind = 'factory';
        return scope;
      }
    }
    // A model class whose file cannot be found (custom autoloader): the table by convention.
    if (/\\Models?\\/.test(fqn) && !this.project?.classFile(fqn)) {
      const guessed: ModelInfo = {
        fqn,
        table: tableForModel(fqn),
        explicitTable: false,
        primaryKey: 'id',
        relations: new Map(),
        scopes: new Map(),
      };
      return this.modelScope(guessed, 'guess');
    }
    return emptyScope();
  }

  /** Applies one `->name(...)` step. */
  applySegment(input: Scope, segment: Segment): Scope {
    const name = segment.name.toLowerCase();
    const args =
      segment.open !== undefined && segment.close !== undefined ? callArgs(this.doc, segment.open, segment.close) : [];
    const scope = input;
    switch (scope.kind) {
      case 'db': {
        if (name === 'connection') {
          const next = cloneScope(scope);
          next.connection = this.literalArg(args[0]);
          return next;
        }
        if (name === 'table' || name === 'query') {
          const next = cloneScope(scope);
          next.kind = 'query';
          const table = this.literalArg(args[0]);
          if (table) {
            const parsed = parseTableExpression(table);
            next.tables.push({ name: parsed.name, alias: parsed.alias ?? this.literalArg(args[1]), origin: 'table' });
          }
          return next;
        }
        return emptyScope();
      }
      case 'schema': {
        if (name === 'connection') {
          const next = cloneScope(scope);
          next.connection = this.literalArg(args[0]);
          return next;
        }
        return scope;
      }
      case 'query':
      case 'model':
      case 'factory':
        return this.applyBuilderSegment(scope, name, segment, args);
      case 'rule': {
        // Rule::exists('users', 'email') / Rule::unique(User::class)->where(...)
        if ((name === 'exists' || name === 'unique') && scope.tables.length === 0) {
          const next = cloneScope(scope);
          const table = this.literalArg(args[0]);
          const model = this.model(this.classArg(args[0]));
          if (model) {
            next.tables.push({ name: model.table, origin: 'model', model });
            next.connection = model.connection;
          } else if (table) {
            const dot = table.indexOf('.');
            next.tables.push({ name: dot > 0 ? table.slice(dot + 1) : table, origin: 'table' });
          }
          return next;
        }
        return scope;
      }
      case 'test':
      case 'blueprint':
        return scope;
      default:
        return scope;
    }
  }

  private applyBuilderSegment(scope: Scope, name: string, segment: Segment, args: Array<[number, number]>): Scope {
    if (segment.open === undefined) {
      // Property access: `$user->posts` (relation as collection), `$model->attribute`
      if (scope.model) {
        const relation = this.project?.relationPath(scope.model, segment.name);
        if (relation?.model) {
          const next = this.modelScope(relation.model, 'relation');
          next.collection = true;
          return next;
        }
      }
      return emptyScope();
    }
    if (name === 'from') {
      const table = this.literalArg(args[0]);
      if (!table) {
        return scope;
      }
      const next = cloneScope(scope);
      const parsed = parseTableExpression(table);
      next.kind = next.kind === 'model' ? 'model' : 'query';
      next.tables = next.tables.filter((t) => t.origin !== 'model' && t.origin !== 'table');
      next.tables.unshift({ name: parsed.name, alias: parsed.alias ?? this.literalArg(args[1]), origin: 'table' });
      return next;
    }
    if (JOIN_METHODS.has(name)) {
      const table = this.literalArg(args[0]);
      if (!table) {
        return scope;
      }
      const next = cloneScope(scope);
      const parsed = parseTableExpression(table);
      next.tables.push({ name: parsed.name, alias: parsed.alias, origin: 'join' });
      return next;
    }
    const subAlias = SUB_ALIAS_METHODS.get(name);
    if (subAlias !== undefined) {
      const alias = this.literalArg(args[subAlias]);
      if (alias) {
        const next = cloneScope(scope);
        next.opaque.add(alias.toLowerCase());
        return next;
      }
      return scope;
    }
    if (name === 'on' || name === 'onconnection' || name === 'setconnection' || name === 'connection') {
      const connection = this.literalArg(args[0]);
      if (connection && scope.kind !== 'query') {
        const next = cloneScope(scope);
        next.connection = connection;
        return next;
      }
      return scope;
    }
    if (name === 'select' || name === 'addselect' || name === 'selectraw' || name === 'selectsub') {
      const next = cloneScope(scope);
      for (const range of args) {
        this.collectAliases(range, next.aliases);
      }
      return next;
    }
    const aggregate = AGGREGATE_ALIASES[name];
    if (aggregate || name === 'withaggregate') {
      const next = cloneScope(scope);
      const relation = this.literalArg(args[0]);
      const column = this.literalArg(args[1]);
      if (relation) {
        const parsed = parseTableExpression(relation);
        if (parsed.alias) {
          next.aliases.add(parsed.alias.toLowerCase());
        } else if (aggregate === 'count' || aggregate === 'exists') {
          next.aliases.add(`${snakeCase(parsed.name)}_${aggregate}`);
        } else if (column) {
          next.aliases.add(`${snakeCase(parsed.name)}_${aggregate}_${column}`.toLowerCase());
        }
      }
      return next;
    }
    if (TERMINAL_METHODS.has(name)) {
      const next = cloneScope(scope);
      next.collection = true;
      return next;
    }
    if (name === 'factory' && scope.model) {
      const next = cloneScope(scope);
      next.kind = 'factory';
      return next;
    }
    // A relation method on a model: `$user->posts()->where(...)`
    if (scope.model && scope.kind !== 'query') {
      const relationInfo = scope.model.relations.get(name);
      if (relationInfo) {
        const related = relationInfo.related ? this.model(relationInfo.related) : undefined;
        if (related) {
          const next = this.modelScope(related, 'relation');
          if (relationInfo.type === 'belongstomany' || relationInfo.type.startsWith('morph')) {
            const pivot = relationInfo.pivotTable ?? pivotTableName(scope.model, related);
            if (relationInfo.type === 'belongstomany' || relationInfo.pivotTable) {
              next.pivot = { name: pivot, origin: 'pivot' };
            }
          }
          return next;
        }
        // A relation to a class we cannot name (morphTo, a runtime-computed class): its query is
        // on another table, so the parent's columns would be wrong.
        return emptyScope();
      }
    }
    // A local scope: `->withAuthors()` brings the tables its body joins.
    if (scope.model) {
      const joins = this.scopeJoins(scope.model, name, new Set());
      if (joins.length > 0) {
        const next = cloneScope(scope);
        for (const join of joins) {
          const parsed = parseTableExpression(join);
          if (!next.tables.some((t) => t.name === parsed.name && t.alias === parsed.alias)) {
            next.tables.push({ name: parsed.name, alias: parsed.alias, origin: 'join' });
          }
        }
        return next;
      }
    }
    return scope;
  }

  /** Tables a local scope joins, with those of the scopes it calls. */
  private scopeJoins(model: ModelInfo, name: string, seen: Set<string>): string[] {
    const local = model.scopes.get(name);
    if (!local || seen.has(name)) {
      return [];
    }
    seen.add(name);
    return [...local.joins, ...local.calls.flatMap((call) => this.scopeJoins(model, call, seen))];
  }

  /** `'col as alias'`, `['alias' => sub]`, `selectRaw('count(*) as total')`. */
  private collectAliases(range: [number, number], into: Set<string>): void {
    const doc = this.doc;
    for (let i = range[0]; i <= range[1]; i++) {
      const token = doc.tok(i);
      const value = literalValue(token);
      if (value !== undefined) {
        for (const match of value.matchAll(/\bas\s+[`"']?(\w+)/gi)) {
          into.add(match[1].toLowerCase());
        }
        if (doc.isOp(i + 1, '=>')) {
          into.add(value.toLowerCase());
        }
      }
    }
  }

  // --- variables --------------------------------------------------------------------------

  scopeOfVariable(name: string, at: number): Scope {
    const key = `v${name}@${at}`;
    const cached = this.memo.get(key);
    if (cached) {
      return cached;
    }
    if (this.depth > 24) {
      return emptyScope();
    }
    this.depth++;
    try {
      const scope = this.resolveVariable(name, at);
      this.memo.set(key, scope);
      return scope;
    } finally {
      this.depth--;
    }
  }

  private resolveVariable(name: string, at: number): Scope {
    const doc = this.doc;
    if (name === '$this') {
      const decl = doc.enclosingClass(at);
      const model = decl?.fqn ? this.model(decl.fqn) : undefined;
      if (model) {
        const scope = this.modelScope(model, 'self');
        scope.self = true;
        return scope;
      }
      if (decl?.fqn && this.project?.isFactory(decl.fqn)) {
        const factoryModel = this.project.factoryModel(decl.fqn);
        if (factoryModel) {
          const scope = this.modelScope(factoryModel);
          scope.kind = 'factory';
          return scope;
        }
      }
      // Test classes and Pest files (closures outside classes)
      if (!decl || /Test(Case)?$/.test(decl.name ?? '') || /TestCase$/i.test(decl.extends ?? '')) {
        return emptyScope('test');
      }
      return emptyScope();
    }
    const functions = doc.enclosingFunctions(at);
    for (const fn of functions) {
      const assigned = this.assignmentScope(name, fn.bodyStart, at, fn);
      if (assigned) {
        return this.withStatements(assigned, name, fn);
      }
      const param = fn.params.find((p) => p.name === name);
      if (param) {
        return this.withStatements(this.scopeOfParam(fn, param), name, fn);
      }
      if (fn.kind === 'arrow' || fn.useVars.includes(name)) {
        continue;
      }
      return emptyScope();
    }
    // File level (scripts, Blade, Pest files)
    return this.assignmentScope(name, 0, at, undefined) ?? emptyScope();
  }

  /**
   * The last assignment `$name = expr` / `foreach (expr as $name)` / `@var` before `at`.
   *
   * A `@var` right above the assignment (or after it) states the type the right-hand side
   * cannot tell, e.g. `$job = app(JobRepository::class)->query()->find($id)`, so it wins.
   * An earlier `@var` is only a fallback when the right-hand side does not resolve.
   */
  private assignmentScope(name: string, from: number, at: number, fn: FunctionDecl | undefined): Scope | undefined {
    const start = Math.max(0, from);
    const assigned = this.lastAssignment(name, start, at, fn);
    // Docs from the token before the assignment: the doc block of its statement and later ones.
    const declared = this.declaredScope(name, assigned ? Math.max(start, assigned.tok - 1) : start, at);
    // A doc naming a model wins; a bare builder type (`@var Builder $query`) says less than a
    // right-hand side that resolves (`Member::query()->join(...)`).
    if (declared?.namesModel || (declared && !assigned)) {
      return declared.scope;
    }
    if (!assigned) {
      return undefined;
    }
    const { scope } = assigned;
    if (scope.tables.length > 0 || scope.model || (scope.kind !== 'unknown' && !scope.inferred)) {
      return scope;
    }
    return (
      declared?.scope ??
      (assigned.tok - 1 > start ? this.declaredScope(name, start, assigned.tok - 1)?.scope : undefined) ??
      scope
    );
  }

  private lastAssignment(
    name: string,
    start: number,
    at: number,
    fn: FunctionDecl | undefined,
  ): { tok: number; scope: Scope } | undefined {
    const doc = this.doc;
    const t = doc.tokens;
    for (let i = at - 1; i >= start; i--) {
      const token = t[i];
      if (token.type !== 'var' || token.value !== name) {
        continue;
      }
      // Skip variables of nested closures that are not this one's
      const inner = doc.enclosingFunctions(i)[0];
      if (fn && inner && inner !== fn && inner.kind !== 'arrow' && !inner.useVars.includes(name)) {
        continue;
      }
      if (doc.isOp(i + 1, '=') && !doc.isOp(i - 1, '->', '::')) {
        const rhsStart = i + 2;
        const rhsEnd = doc.expressionEnd(rhsStart);
        if (rhsEnd < rhsStart) {
          continue;
        }
        // `$q = $q->where(...)` refers to the previous $q: resolve before this statement.
        return { tok: i, scope: this.scopeOfExpression(this.lastChainToken(rhsStart, rhsEnd)) };
      }
      if (doc.isIdent(i - 1, 'as') || (doc.isOp(i - 1, '=>') && this.isForeachValue(i))) {
        const open = this.foreachOpen(i);
        if (open >= 0) {
          const asTok = this.foreachAs(open, i);
          if (asTok > open + 1) {
            const scope = cloneScope(this.scopeOfExpression(asTok - 1));
            scope.collection = true;
            return { tok: i, scope };
          }
        }
      }
    }
    return undefined;
  }

  /** The type of the last `/** @var User $user *\/` for `$name` within the token range [from, to]. */
  private declaredScope(name: string, from: number, to: number): { scope: Scope; namesModel: boolean } | undefined {
    const docs = this.doc.docsBetween(from, to);
    for (let d = docs.length - 1; d >= 0; d--) {
      const type = docType(docs[d].value, '@var', name);
      if (type) {
        const scope = this.scopeOfType(type, to);
        if (scope) {
          const namesModel = type
            .split(/[|<>,\s]+/)
            .some((part) => !!part && !!this.model(this.resolveClassName(part.replace(/^\?|\[\]$/g, ''), to)));
          return { scope, namesModel };
        }
      }
    }
    return undefined;
  }

  private isForeachValue(i: number): boolean {
    return this.foreachOpen(i) >= 0;
  }

  private foreachOpen(i: number): number {
    const doc = this.doc;
    for (let j = i - 1; j >= 0 && j > i - 200; j--) {
      if (doc.isOp(j, '(') && doc.isIdent(j - 1, 'foreach') && doc.match[j] > i) {
        return j;
      }
      if (doc.isOp(j, ';', '{', '}')) {
        return -1;
      }
    }
    return -1;
  }

  private foreachAs(open: number, until: number): number {
    for (let j = open + 1; j < until; j++) {
      if (this.doc.isIdent(j, 'as')) {
        return j;
      }
    }
    return -1;
  }

  /** The last token of the chain within an expression (skips trailing `?? x`, casts…). */
  private lastChainToken(start: number, end: number): number {
    const doc = this.doc;
    // Stop at the first top-level binary operator after the chain: `User::query() ?? null`
    for (let i = start; i <= end; i++) {
      if (doc.isOp(i, '(', '[', '{')) {
        const pair = doc.match[i];
        if (pair > i) {
          i = pair;
        }
        continue;
      }
      if (doc.isOp(i, '??', '?:', '?', '||', '&&', '.', '+', '-', '*', '/')) {
        return i - 1;
      }
    }
    return end;
  }

  /** Adds tables joined to a variable in other statements of the function (`$q->join(...)`). */
  private withStatements(scope: Scope, name: string, fn: FunctionDecl): Scope {
    if (scope.kind !== 'query' && scope.kind !== 'model') {
      return scope;
    }
    const doc = this.doc;
    const t = doc.tokens;
    let result = scope;
    for (let i = fn.bodyStart; i <= fn.bodyEnd && i < t.length; i++) {
      if (t[i].type !== 'var' || t[i].value !== name || !doc.isOp(i + 1, '->', '?->')) {
        continue;
      }
      for (const segment of segmentsAfter(doc, i)) {
        const lower = segment.name.toLowerCase();
        if (JOIN_METHODS.has(lower) || lower === 'from' || SUB_ALIAS_METHODS.has(lower)) {
          result = this.applySegment(result, segment);
        }
        if (result.inferred && segment.open !== undefined && segment.close !== undefined) {
          if (result === scope) {
            result = cloneScope(scope);
          }
          this.collectMentioned(segment.open, segment.close, result);
        }
      }
    }
    return dedupeTables(result);
  }

  scopeOfType(type: string, at: number): Scope | undefined {
    const cleaned = type.replace(/^\?/, '');
    // Builder<User>, Collection<int, User>, HasMany<Post, $this>
    const generic = /<\s*(?:[\w\\]+\s*,\s*)?([\\\w]+)/.exec(cleaned);
    if (generic && BUILDER_TYPES.test(cleaned)) {
      const model = this.model(this.resolveClassName(generic[1], at));
      if (model) {
        return this.modelScope(model);
      }
    }
    let builder = BUILDER_TYPES.test(cleaned);
    for (const part of cleaned.split('|')) {
      const name = part.replace(/<.*$/, '').replace(/\[\]$/, '').trim();
      if (!name || /^(null|array|int|string|mixed|bool|void|static|self|callable)$/i.test(name)) {
        continue;
      }
      if (BLUEPRINT_TYPE.test(name)) {
        const scope = emptyScope('blueprint');
        return scope;
      }
      const fqn = this.resolveClassName(name, at);
      const model = this.model(fqn);
      if (model) {
        const scope = this.modelScope(model);
        if (part.endsWith('[]') || /Collection/.test(cleaned)) {
          scope.collection = true;
        }
        return scope;
      }
      builder ||= this.project?.extendsAny(fqn, BUILDER_BASES) ?? false;
    }
    if (builder) {
      // A builder of unknown tables; inside a model it is the model's own query (scopes).
      const decl = this.doc.enclosingClass(at);
      const model = decl?.fqn ? this.model(decl.fqn) : undefined;
      if (model) {
        return this.modelScope(model);
      }
      // Its tables come from its joins and the qualifiers its strings name.
      return { ...emptyScope('query'), inferred: true };
    }
    return undefined;
  }

  private scopeOfParam(fn: FunctionDecl, param: Param): Scope {
    const docTypeValue = fn.doc ? docType(fn.doc, '@param', param.name) : undefined;
    if (fn.kind === 'closure' || fn.kind === 'arrow') {
      const fromCall = this.closureScope(fn, param);
      if (fromCall) {
        return fromCall;
      }
    }
    for (const type of [docTypeValue, param.type]) {
      if (type) {
        const scope = this.scopeOfType(type, param.tok);
        if (scope) {
          return scope;
        }
      }
    }
    // `public function scopeActive($query)`: a local scope's first parameter is the model's builder.
    if (fn.kind === 'method' && fn.params[0] === param && /^scope[A-Z_]/.test(fn.name ?? '')) {
      const decl = this.doc.enclosingClass(param.tok);
      const model = decl?.fqn ? this.model(decl.fqn) : undefined;
      if (model) {
        return this.modelScope(model);
      }
    }
    return emptyScope();
  }

  /** What a closure parameter is, from the call the closure is passed to. */
  private closureScope(fn: FunctionDecl, param: Param): Scope | undefined {
    const doc = this.doc;
    const site = siteOf(doc, fn.start);
    if (site?.type !== 'call') {
      return undefined;
    }
    const paramIndex = fn.params.indexOf(param);
    const method = site.name.toLowerCase();
    const outer = this.scopeOfReceiver(site);
    const args = callArgs(doc, site.open, site.close);
    const typed = param.type ? this.scopeOfType(param.type, param.tok) : undefined;

    if (outer.kind === 'schema' && (method === 'create' || method === 'table') && paramIndex === 0) {
      const scope = emptyScope('blueprint');
      scope.connection = outer.connection;
      scope.blueprintMode = method;
      const table = this.literalArg(args[0]);
      if (table) {
        scope.tables.push({ name: table, origin: 'self' });
      }
      return scope;
    }
    const kind = closureKind(method);
    if (outer.kind === 'unknown' && kind === 'join' && site.argIndex === 1 && paramIndex === 0) {
      // `$repository->query()->leftJoin('posts', function ($join) {...})`: the joined table is known
      // even when the outer query is not.
      const table = this.literalArg(args[0]);
      if (table) {
        const parsed = parseTableExpression(table);
        const scope: Scope = { ...emptyScope('query'), inferred: true };
        scope.tables.push({ name: parsed.name, alias: parsed.alias, origin: 'join' });
        return scope;
      }
    }
    if (outer.kind === 'db' || outer.kind === 'test' || outer.kind === 'unknown' || outer.kind === 'blueprint') {
      return typed && typed.kind !== 'blueprint' ? typed : undefined;
    }

    const firstArgIsClosure = site.argIndex === 0 && site.arrays.length === 0;
    if (kind === 'nested' && firstArgIsClosure && paramIndex === 0) {
      return cloneScope(outer);
    }
    if (kind === 'when' && site.argIndex >= 1 && paramIndex === 0) {
      return cloneScope(outer);
    }
    if (kind === 'join' && site.argIndex === 1 && paramIndex === 0) {
      const scope = cloneScope(outer);
      const table = this.literalArg(args[0]);
      if (table) {
        const parsed = parseTableExpression(table);
        // The joined table first: `$join->on(...)` is mostly about it.
        scope.tables = scope.tables.filter(
          (t) => !(t.origin === 'join' && t.name === parsed.name && t.alias === parsed.alias),
        );
        scope.tables.unshift({ name: parsed.name, alias: parsed.alias, origin: 'join' });
      }
      scope.kind = 'query';
      return scope;
    }
    if (kind === 'relation' && paramIndex === 0) {
      let relation: string | undefined;
      if (site.arrays.length && site.arrays[0].isValue && site.arrays[0].keyTok !== undefined) {
        relation = literalValue(doc.tok(site.arrays[0].keyTok));
      } else if (site.argIndex >= 1) {
        relation = this.literalArg(args[0]);
      }
      if (relation) {
        const related = this.relatedScope(outer, parseTableExpression(relation).name, args, method);
        if (related) {
          return related;
        }
      }
      return typed ?? emptyScope('query');
    }
    if ((kind === 'subquery' || (kind === 'nested' && !firstArgIsClosure)) && paramIndex === 0) {
      return this.subqueryScope(outer, fn, param.name);
    }
    if (kind === 'chunk') {
      const scope = cloneScope(outer);
      scope.collection = true;
      return scope;
    }
    if (typed) {
      return typed.kind === 'query' && typed.tables.length === 0 ? cloneScope(outer) : typed;
    }
    return undefined;
  }

  /** Scope of a relation path from the outer model (`posts.comments`). */
  private relatedScope(outer: Scope, path: string, args: Array<[number, number]>, method: string): Scope | undefined {
    if (/morph/i.test(method)) {
      // whereHasMorph('commentable', [Post::class, Video::class], fn)
      const types = args[1];
      if (types) {
        const scope = emptyScope('query');
        for (let i = types[0]; i <= types[1]; i++) {
          const cls = this.classArg([i, i + 2]);
          const model = this.model(cls);
          if (model) {
            scope.tables.push({ name: model.table, origin: 'relation', model });
            scope.model ??= model;
          }
        }
        if (scope.tables.length) {
          return scope;
        }
      }
    }
    if (outer.model && this.project) {
      const { model, relation } = this.project.relationPath(outer.model, path);
      if (model) {
        const scope = this.modelScope(model, 'relation');
        if (relation?.type === 'belongstomany' || relation?.pivotTable) {
          scope.pivot = { name: relation.pivotTable ?? pivotTableName(outer.model, model), origin: 'pivot' };
        }
        return scope;
      }
    }
    // Unknown relation: guess the table from its name (`posts`, `comments`).
    const last = path.split('.').pop() ?? path;
    const scope = emptyScope('query');
    scope.tables.push({ name: snakeCase(last), origin: 'guess' });
    scope.tables.push({ name: tableForModel(studly(last)), origin: 'guess' });
    return scope;
  }

  /** Tables a closure's own statements select from, then the outer query's (correlation). */
  private subqueryScope(outer: Scope, fn: FunctionDecl, name: string): Scope {
    const doc = this.doc;
    const t = doc.tokens;
    let inner = emptyScope('query');
    inner.connection = outer.connection;
    for (let i = fn.bodyStart; i <= fn.bodyEnd && i < t.length; i++) {
      if (t[i].type !== 'var' || t[i].value !== name || !doc.isOp(i + 1, '->', '?->')) {
        continue;
      }
      for (const segment of segmentsAfter(doc, i)) {
        const lower = segment.name.toLowerCase();
        if (lower === 'from' || lower === 'table' || JOIN_METHODS.has(lower) || SUB_ALIAS_METHODS.has(lower)) {
          inner = this.applyBuilderSegment(
            inner,
            lower === 'table' ? 'from' : lower,
            segment,
            segment.open !== undefined && segment.close !== undefined ? callArgs(doc, segment.open, segment.close) : [],
          );
        }
      }
    }
    for (const table of outer.tables) {
      inner.tables.push({ ...table, origin: 'outer' });
    }
    for (const alias of outer.opaque) {
      inner.opaque.add(alias);
    }
    inner.model = inner.tables.length && inner.tables[0].origin !== 'outer' ? undefined : outer.model;
    return dedupeTables(inner);
  }
}

function dedupeTables(scope: Scope): Scope {
  const seen = new Set<string>();
  const tables: TableRef[] = [];
  for (const table of scope.tables) {
    const key = `${table.name.toLowerCase()}|${table.alias?.toLowerCase() ?? ''}|${table.connection ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      tables.push(table);
    }
  }
  if (tables.length === scope.tables.length) {
    return scope;
  }
  return { ...scope, tables };
}

/** Laravel's default pivot name: both singular snake model names, sorted, joined by `_`. */
function pivotTableName(a: ModelInfo, b: ModelInfo): string {
  const base = (m: ModelInfo) => snakeCase(m.fqn.split('\\').pop() ?? m.fqn);
  return [base(a), base(b)].sort().join('_');
}

export function snakeCase(value: string): string {
  return value.replace(/(.)(?=[A-Z])/g, '$1_').toLowerCase();
}

function studly(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Type of `$name` in a doc comment tag (`@var Type $name`, `@param Type $name`). */
export function docType(doc: string, tag: '@var' | '@param', name: string): string | undefined {
  const escaped = name.replace(/\$/g, '\\$');
  const re = new RegExp(`${tag}\\s+([^\\s*]+(?:<[^>]*>)?)\\s+${escaped}\\b`);
  const match = re.exec(doc);
  if (match) {
    return match[1];
  }
  if (tag === '@var') {
    // `@var User` right above `$user = …` (no variable name)
    const bare = /@var\s+([^\s*]+)\s*\*\//.exec(doc);
    if (bare && !bare[1].startsWith('$')) {
      return undefined;
    }
  }
  return undefined;
}
