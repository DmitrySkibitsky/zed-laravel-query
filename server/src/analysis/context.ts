/**
 * What a string literal means to the database: a table, a column of some tables, a relation,
 * a connection, an index name or an operator — and which tables its columns come from.
 */

import {
  type ArgKind,
  BLUEPRINT_COLUMN_TYPES,
  BLUEPRINT_METHODS,
  BUILDER_METHODS,
  DB_METHODS,
  kindsAt,
  type MethodCatalog,
  MODEL_COLUMN_PROPERTIES,
  MODEL_RELATION_PROPERTIES,
  RELATED_COLUMN_METHODS,
  RELATION_TYPES,
  RULE_METHODS,
  RULE_STATIC_METHODS,
  rulesFor,
  SCHEMA_METHODS,
  TEST_METHODS,
} from '../laravel/methods.ts';
import type { ModelInfo } from '../laravel/project.ts';
import { literalValue } from '../php/document.ts';
import type { StringToken } from '../php/lexer.ts';
import { type CallSite, callArgs, type Site, segmentsAfter, siteOf } from './chain.ts';
import {
  type Analyzer,
  BUILDER_EVIDENCE,
  emptyScope,
  parseTableExpression,
  SAME_QUERY_CLOSURES,
  type Scope,
  type TableRef,
} from './scope.ts';

/** Builder methods whose first argument means something else on a collection. */
const COLLECTION_NON_COLUMN = new Set(['get', 'first', 'firstorfail']);

export type ContextKind = 'column' | 'table' | 'relation' | 'connection' | 'index' | 'operator';

export interface QueryContext {
  kinds: ContextKind[];
  scope: Scope;
  tokenIndex: number;
  token: StringToken;
  /** Offsets of the part of the string the context is about (a rule segment, a relation's column list). */
  segmentStart: number;
  segmentEnd: number;
  site?: Site;
  /** Model whose relations a relation context offers. */
  relationModel?: ModelInfo;
  /** Operators make sense here (comparison argument of a 3+ argument where). */
  operators?: boolean;
  /** The string may name a column that does not exist yet (column definitions): not checked. */
  newColumn?: boolean;
  /** Inside a validation rule string (`exists:table,column`). */
  rule?: boolean;
}

const OPERATOR_FIRST = new Set(['where', 'orwhere', 'wherenot', 'orwherenot', 'having', 'orhaving', 'firstwhere']);

export function contextAt(analyzer: Analyzer, tokenIndex: number): QueryContext | undefined {
  const doc = analyzer.doc;
  const token = doc.stringAt(tokenIndex);
  if (!token || token.quote.startsWith('<<<')) {
    return undefined;
  }
  const rule = ruleContext(tokenIndex, token);
  if (rule) {
    return rule;
  }
  // `$table . '.status'`: a fragment of a concatenation is not a whole name.
  if (token.interpolated || doc.isOp(tokenIndex - 1, '.') || doc.isOp(tokenIndex + 1, '.')) {
    return undefined;
  }
  const site = siteOf(doc, tokenIndex);
  if (!site) {
    return undefined;
  }
  const base = { tokenIndex, token, segmentStart: token.contentStart, segmentEnd: token.contentEnd, site };
  if (site.type === 'property') {
    return propertyContext(analyzer, tokenIndex, site, base);
  }
  if (site.type === 'return') {
    return returnContext(analyzer, tokenIndex, site, base);
  }
  return callContext(analyzer, site, base);
}

type Base = Pick<QueryContext, 'tokenIndex' | 'token' | 'segmentStart' | 'segmentEnd' | 'site'>;

function propertyContext(
  analyzer: Analyzer,
  tokenIndex: number,
  site: Extract<Site, { type: 'property' }>,
  base: Base,
): QueryContext | undefined {
  const doc = analyzer.doc;
  const decl = doc.enclosingClass(tokenIndex);
  const model = decl?.fqn ? analyzer.model(decl.fqn) : undefined;
  if (!model) {
    return undefined;
  }
  const scope = analyzer.modelScope(model, 'self');
  const arrays = site.arrays;
  const name = site.name;
  if (arrays.length === 0) {
    return undefined;
  }
  const level = arrays[0];
  if (MODEL_RELATION_PROPERTIES.has(name) && !level.isKey) {
    return relationContext(analyzer, base, model);
  }
  if (MODEL_COLUMN_PROPERTIES.has(name)) {
    const keyed = name === '$casts' || name === '$attributes';
    if (keyed ? level.isKey : !level.isKey && !level.isValue) {
      return { ...base, kinds: ['column'], scope };
    }
  }
  return undefined;
}

/** `protected $table = 'users';` — not an array, so siteOf() gives nothing; handled here. */
export function scalarPropertyContext(analyzer: Analyzer, tokenIndex: number): QueryContext | undefined {
  const doc = analyzer.doc;
  const token = doc.stringAt(tokenIndex);
  if (!token || !doc.isOp(tokenIndex - 1, '=') || doc.tok(tokenIndex - 2)?.type !== 'var') {
    return undefined;
  }
  if (!doc.isOp(tokenIndex + 1, ';') || doc.tok(tokenIndex - 3)?.type !== 'ident') {
    return undefined;
  }
  const name = doc.tok(tokenIndex - 2)?.value;
  const decl = doc.enclosingClass(tokenIndex);
  if (!decl?.fqn) {
    return undefined;
  }
  const base = { tokenIndex, token, segmentStart: token.contentStart, segmentEnd: token.contentEnd };
  const isModel = analyzer.project?.isModel(decl.fqn) ?? false;
  if (!isModel) {
    return undefined;
  }
  if (name === '$table') {
    return { ...base, kinds: ['table'], scope: emptyScope('query') };
  }
  if (name === '$connection') {
    return { ...base, kinds: ['connection'], scope: emptyScope('query') };
  }
  if (name === '$primaryKey') {
    const model = analyzer.model(decl.fqn);
    return model ? { ...base, kinds: ['column'], scope: analyzer.modelScope(model, 'self') } : undefined;
  }
  return undefined;
}

function returnContext(
  analyzer: Analyzer,
  tokenIndex: number,
  site: Extract<Site, { type: 'return' }>,
  base: Base,
): QueryContext | undefined {
  const doc = analyzer.doc;
  const fn = doc.enclosingFunctions(tokenIndex).find((f) => f.kind === 'method');
  const decl = doc.enclosingClass(tokenIndex);
  if (!fn?.name || !decl?.fqn || site.arrays.length === 0) {
    return undefined;
  }
  const method = fn.name.toLowerCase();
  const level = site.arrays[site.arrays.length - 1];
  const innermost = site.arrays[0];
  if (method === 'casts' && innermost.isKey && site.arrays.length === 1) {
    const model = analyzer.model(decl.fqn);
    return model ? { ...base, kinds: ['column'], scope: analyzer.modelScope(model, 'self') } : undefined;
  }
  if (method === 'definition' && innermost.isKey && site.arrays.length === 1 && analyzer.project?.isFactory(decl.fqn)) {
    const model = analyzer.project.factoryModel(decl.fqn);
    return model ? { ...base, kinds: ['column'], scope: analyzer.modelScope(model) } : undefined;
  }
  void level;
  return undefined;
}

function catalogFor(scope: Scope, site: CallSite): MethodCatalog | undefined {
  switch (scope.kind) {
    case 'db':
      return DB_METHODS;
    case 'schema':
      return SCHEMA_METHODS;
    case 'blueprint':
      return BLUEPRINT_METHODS;
    case 'test':
      return TEST_METHODS;
    case 'rule':
      return site.kind === 'static' ? RULE_STATIC_METHODS : RULE_METHODS;
    case 'query':
    case 'model':
    case 'factory':
      return BUILDER_METHODS;
    default:
      return undefined;
  }
}

function callContext(analyzer: Analyzer, site: CallSite, base: Base): QueryContext | undefined {
  const doc = analyzer.doc;
  const method = site.name.toLowerCase();

  if (site.kind === 'function' && isAttribute(doc, site.nameTok)) {
    return attributeContext(analyzer, site, base);
  }

  // Relation definitions: `$this->hasMany(Post::class, 'user_id', 'id')` in a model.
  if (site.kind === 'method' && RELATION_TYPES.has(method) && doc.tok(site.receiverEnd)?.value === '$this') {
    return relationDefinitionContext(analyzer, site, base);
  }

  let scope: Scope;
  if (site.kind === 'new') {
    const model = analyzer.model(analyzer.resolveClassName(site.name, site.nameTok));
    if (!model) {
      return undefined;
    }
    scope = analyzer.modelScope(model);
  } else {
    scope = analyzer.scopeOfReceiver(site);
    // A service or action object is no query of its own.
    if (scope.kind === 'object') {
      scope = emptyScope();
    }
    // An unresolvable receiver: builder-only methods still tell it is a query.
    if (scope.kind === 'unknown' && site.kind === 'method') {
      if (rulesFor(TEST_METHODS, method)) {
        scope = emptyScope('test');
      } else if (BUILDER_EVIDENCE.has(method)) {
        scope = analyzer.inferQuery([{ name: site.name, nameTok: site.nameTok, open: site.open, close: site.close }]);
      }
    }
  }
  if (site.kind === 'new') {
    return site.argIndex === 0 && site.arrays.length === 1 && site.arrays[0].isKey
      ? { ...base, kinds: ['column'], scope }
      : undefined;
  }
  if (scope.kind === 'unknown') {
    return undefined;
  }
  // Model::on('connection') vs $join->on('a.id', '=', 'b.id')
  if (method === 'on' && site.kind === 'static' && scope.model) {
    return site.argIndex === 0 && site.arrays.length === 0 ? { ...base, kinds: ['connection'], scope } : undefined;
  }
  const catalog = catalogFor(scope, site);
  let rules = catalog ? rulesFor(catalog, method) : undefined;
  if (!rules && scope.kind === 'blueprint' && BLUEPRINT_COLUMN_TYPES.has(method)) {
    rules = [{ kind: 'column', index: 0, variadic: false }];
  }
  if (!rules) {
    return undefined;
  }
  const args = callArgs(doc, site.open, site.close);
  const argCount = args.length;
  let kinds = filterByPosition(kindsAt(rules, site.argIndex), site);
  if (RELATED_COLUMN_METHODS.has(method) && site.argIndex === 1 && site.arrays.length === 0) {
    kinds = ['column'];
  }
  // A repository's own `find($id, $with = [])` is not the builder's `find($id, $columns)`: its
  // parameter names tell what an argument is.
  if (scope.repository && site.arrays.length <= 1) {
    const param = analyzer.project?.methodInfo(scope.repository, method)?.params[site.argIndex];
    if (param !== undefined) {
      if (/^(with|relations?|load|eager)/i.test(param)) {
        kinds = ['relation'];
      } else if (!/(column|field|select|attribute|data|values|input|key)/i.test(param)) {
        return undefined;
      }
    }
  }
  // A collection's join(', ') glues strings, get('key') / first() take a key or a callback.
  if (scope.collection && (kinds.includes('table') || COLLECTION_NON_COLUMN.has(method))) {
    return undefined;
  }
  if (kinds.length === 0) {
    return undefined;
  }

  // Columns of this call's own table argument: join('posts as p', 'p.id'), hasColumn('users', 'x').
  const own: TableRef[] = [];
  rules.forEach((rule) => {
    if (rule.kind !== 'table' || rule.index === site.argIndex) {
      return;
    }
    const range = args[rule.index];
    const value = analyzer.literalArg(range);
    if (value) {
      const parsed = parseTableExpression(value);
      own.push({ name: parsed.name, alias: parsed.alias, origin: 'self' });
      return;
    }
    const model = analyzer.model(analyzer.classArg(range));
    if (model) {
      own.push({ name: model.table, origin: 'self', model });
    }
  });
  let result: Scope = scope;
  if (own.length || scope.kind === 'query' || scope.kind === 'model' || scope.kind === 'factory') {
    result = {
      ...scope,
      tables: [...own, ...scope.tables],
      aliases: new Set(scope.aliases),
      opaque: new Set(scope.opaque),
    };
    if (scope.kind === 'schema' || scope.kind === 'test') {
      result.kind = 'query';
    }
  }

  // Joins after the cursor belong to the same query.
  if (site.close > 0 && (result.kind === 'query' || result.kind === 'model' || result.kind === 'factory')) {
    for (const segment of segmentsAfter(doc, site.close)) {
      const lower = segment.name.toLowerCase();
      if (/join/.test(lower) || lower === 'from' || SAME_QUERY_CLOSURES.has(lower)) {
        const extended = analyzer.applySegment(result, segment);
        if (extended.tables.length >= result.tables.length) {
          result = extended;
        }
      }
      if (result.inferred && segment.open !== undefined && segment.close !== undefined) {
        analyzer.collectMentioned(segment.open, segment.close, result);
      }
    }
  }

  if (result.inferred && site.close > 0) {
    analyzer.collectMentioned(site.open, site.close, result);
  }
  const context: QueryContext = { ...base, kinds: [], scope: result };

  // whereRelation('posts', 'title'), withSum('orders', 'total'): columns of the related model.
  if (RELATED_COLUMN_METHODS.has(method) && site.argIndex === 1 && result.model && analyzer.project) {
    const relation = analyzer.literalArg(args[0]);
    const related = relation ? analyzer.project.relationPath(result.model, parseTableExpression(relation).name) : {};
    if (related.model) {
      context.scope = analyzer.modelScope(related.model, 'relation');
    } else if (relation) {
      context.scope = { ...emptyScope('query'), tables: [{ name: relation, origin: 'guess' }] };
    }
    kinds = ['column'];
  }

  // $table->foreign('user_id')->references('id')->on('users')
  if (scope.kind === 'blueprint' && method === 'references') {
    const on = segmentsAfter(doc, site.close).find((s) => s.name.toLowerCase() === 'on');
    const table =
      on?.open !== undefined && on.close !== undefined
        ? analyzer.literalArg(callArgs(doc, on.open, on.close)[0])
        : undefined;
    context.scope = {
      ...emptyScope('query'),
      connection: scope.connection,
      tables: table ? [{ name: table, origin: 'self' }] : [],
    };
  }
  if (scope.kind === 'blueprint' && BLUEPRINT_COLUMN_TYPES.has(method)) {
    // Schema::create names new columns; Schema::table may name new or existing (->change()).
    if (scope.blueprintMode !== 'table') {
      return undefined;
    }
    context.newColumn = true;
  }

  const out: ContextKind[] = [];
  for (const kind of kinds) {
    switch (kind) {
      case 'column':
      case 'keyColumn':
        out.push('column');
        break;
      case 'pivot':
        if (result.pivot) {
          context.scope = { ...emptyScope('query'), connection: result.connection, tables: [result.pivot] };
          out.push('column');
        }
        break;
      case 'operator': {
        const comparisonCall =
          OPERATOR_FIRST.has(method) || method.includes('date') || /^(or)?wherecolumn$/.test(method);
        if (argCount >= 3 || !comparisonCall) {
          context.operators = true;
          out.push('operator');
        }
        break;
      }
      case 'relation':
        return relationContext(analyzer, base, result.model, context.scope);
      default:
        out.push(kind as ContextKind);
    }
  }
  // whereColumn('a', 'b'): the second argument is a column when there are only two.
  if (out.includes('operator') && kinds.includes('column') && argCount < 3) {
    context.operators = false;
  }
  context.kinds = [...new Set(out)];
  if (context.operators && out[0] === 'operator') {
    // Operator position: offer operators first, columns too when the spec allows them.
    context.kinds = ['operator', ...context.kinds.filter((k) => k !== 'operator')];
  }
  return context.kinds.length ? context : undefined;
}

/** Whether the name at `nameTok` is a class attribute: `#[Name(` or `#[Other, Name(`. */
function isAttribute(doc: Analyzer['doc'], nameTok: number): boolean {
  for (let i = nameTok - 1; i >= 0 && i > nameTok - 200; i--) {
    if (doc.isOp(i, '#[')) {
      return doc.match[i] > nameTok;
    }
    if (doc.isOp(i, ')', ']')) {
      const pair = doc.match[i];
      i = pair < 0 ? i : pair;
      continue;
    }
    if (!doc.isOp(i, ',') && doc.tok(i)?.type !== 'ident') {
      return false;
    }
  }
  return false;
}

/**
 * Eloquent model attributes: `#[Fillable(['name'])]`, `#[Hidden([...])]`, `#[Table('users', key:
 * 'uuid')]`, `#[Connection('logs')]`, `#[Touches(['post'])]`, `#[RouteKey('slug')]`.
 */
function attributeContext(analyzer: Analyzer, site: CallSite, base: Base): QueryContext | undefined {
  const doc = analyzer.doc;
  const decl = doc.classes.filter((c) => c.keyword > site.close).sort((a, b) => a.keyword - b.keyword)[0];
  const fqn = decl?.fqn;
  if (!fqn || !analyzer.project?.isModel(fqn)) {
    return undefined;
  }
  const model = analyzer.model(fqn);
  const name = (site.name.split('\\').pop() ?? '').toLowerCase();
  const position = site.argName?.toLowerCase() ?? site.argIndex;
  const inList = site.arrays.length === 1 && !site.arrays[0].isKey && !site.arrays[0].isValue;
  const direct = site.arrays.length === 0;
  const columns = (): QueryContext | undefined =>
    model ? { ...base, kinds: ['column'], scope: analyzer.modelScope(model, 'self') } : undefined;
  switch (name) {
    case 'fillable':
    case 'guarded':
    case 'hidden':
    case 'visible':
      return inList || direct ? columns() : undefined;
    case 'routekey':
      return direct ? columns() : undefined;
    case 'table':
      if (!direct) {
        return undefined;
      }
      if (position === 0 || position === 'name') {
        return { ...base, kinds: ['table'], scope: { ...emptyScope('query'), connection: model?.connection } };
      }
      return position === 1 || position === 'key' ? columns() : undefined;
    case 'connection':
      return direct ? { ...base, kinds: ['connection'], scope: emptyScope('query') } : undefined;
    case 'touches':
      return (inList || direct) && model ? relationContext(analyzer, base, model) : undefined;
    default:
      return undefined;
  }
}

/** Keeps the kinds that fit the string's place: direct argument, array key or array value. */
function filterByPosition(kinds: ArgKind[], site: CallSite): ArgKind[] {
  if (site.arrays.length === 0) {
    return kinds.filter((k) => k !== 'keyColumn');
  }
  const level = site.arrays[0];
  if (level.isKey) {
    return kinds.filter((k) => k === 'keyColumn' || k === 'relation');
  }
  if (level.isValue) {
    // ['posts' => fn] keys are relations; values that are strings: `upsert(..., ['col'])`? no.
    return kinds.filter((k) => k === 'column' && site.arrays.length > 1);
  }
  // where([['status', '=', 1]]): nested condition arrays
  if (site.arrays.length >= 2 && kinds.includes('keyColumn')) {
    if (level.elementIndex === 0) {
      return ['column'];
    }
    if (level.elementIndex === 1) {
      return ['operator'];
    }
    return [];
  }
  return kinds
    .filter((k) => k === 'column' || k === 'relation' || k === 'index' || k === 'pivot' || k === 'table')
    .map((k) => (k === 'index' ? 'column' : k));
}

function relationContext(
  analyzer: Analyzer,
  base: Base,
  model: ModelInfo | undefined,
  scope?: Scope,
): QueryContext | undefined {
  const token = base.token;
  if (!model) {
    return undefined;
  }
  const value = token.value;
  // with('posts:id,title'): after the colon, columns of the (last) relation
  const colon = value.indexOf(':');
  if (colon >= 0 && analyzer.project) {
    const relationPath = value.slice(0, colon).trim();
    const related = analyzer.project.relationPath(model, relationPath);
    const relatedScope = related.model
      ? analyzer.modelScope(related.model, 'relation')
      : {
          ...emptyScope('query'),
          tables: [{ name: relationPath.split('.').pop() ?? relationPath, origin: 'guess' as const }],
        };
    return {
      ...base,
      kinds: ['column'],
      scope: relatedScope,
      segmentStart: token.contentStart + colon + 1,
      relationModel: related.model,
    };
  }
  return { ...base, kinds: ['relation'], scope: scope ?? analyzer.modelScope(model), relationModel: model };
}

/** Column arguments of relation definitions point at different models per position. */
function relationDefinitionContext(analyzer: Analyzer, site: CallSite, base: Base): QueryContext | undefined {
  const doc = analyzer.doc;
  const decl = doc.enclosingClass(site.nameTok);
  const self = decl?.fqn ? analyzer.model(decl.fqn) : undefined;
  if (!self || site.arrays.length) {
    return undefined;
  }
  const args = callArgs(doc, site.open, site.close);
  const related = analyzer.model(analyzer.classArg(args[0]));
  const method = site.name.toLowerCase();
  const index = site.argIndex;
  let target: 'self' | 'related' | 'through' | 'pivot' | 'table' | undefined;
  switch (method) {
    case 'hasone':
    case 'hasmany':
      target = index === 1 ? 'related' : index === 2 ? 'self' : undefined;
      break;
    case 'belongsto':
      target = index === 1 ? 'self' : index === 2 ? 'related' : undefined;
      break;
    case 'belongstomany':
      target =
        index === 1
          ? 'table'
          : index === 2 || index === 3
            ? 'pivot'
            : index === 4
              ? 'self'
              : index === 5
                ? 'related'
                : undefined;
      break;
    case 'hasonethrough':
    case 'hasmanythrough':
      target = index === 2 || index === 5 ? 'through' : index === 3 ? 'related' : index === 4 ? 'self' : undefined;
      break;
    case 'morphtomany':
    case 'morphedbymany':
      target = index === 2 ? 'table' : undefined;
      break;
    default:
      target = undefined;
  }
  if (!target) {
    return undefined;
  }
  if (target === 'table') {
    return { ...base, kinds: ['table'], scope: { ...emptyScope('query'), connection: self.connection } };
  }
  let model: ModelInfo | undefined;
  let table: string | undefined;
  if (target === 'self') {
    model = self;
  } else if (target === 'related') {
    model = related;
  } else if (target === 'through') {
    model = analyzer.model(analyzer.classArg(args[1]));
  } else {
    table = analyzer.literalArg(args[1]);
  }
  if (model) {
    return { ...base, kinds: ['column'], scope: analyzer.modelScope(model, 'self') };
  }
  if (table) {
    return {
      ...base,
      kinds: ['column'],
      scope: { ...emptyScope('query'), connection: self.connection, tables: [{ name: table, origin: 'self' }] },
    };
  }
  return undefined;
}

/**
 * `'exists:users,email'` / `'required|unique:mysql.users,email,NULL,id'`; undefined when the
 * string is no rule. The part under the cursor is found later with ruleSegmentAt().
 */
function ruleContext(tokenIndex: number, token: StringToken): QueryContext | undefined {
  const value = token.value;
  if (!/(^|\|)\s*(exists|unique):/i.test(value) || token.interpolated) {
    return undefined;
  }
  // One context per rule segment; the caller narrows by cursor with ruleSegmentAt().
  return {
    tokenIndex,
    token,
    segmentStart: token.contentStart,
    segmentEnd: token.contentEnd,
    kinds: ['table'],
    scope: emptyScope('query'),
    rule: true,
  };
}

export interface RuleSegment {
  kind: 'table' | 'column' | 'none';
  /** Offsets within the string content. */
  start: number;
  end: number;
  connection?: string;
  table?: string;
}

/** The part of a validation rule string at content offset `at`. */
export function ruleSegmentAt(value: string, at: number): RuleSegment {
  let ruleStart = 0;
  for (const part of value.split('|')) {
    const ruleEnd = ruleStart + part.length;
    if (at >= ruleStart && at <= ruleEnd) {
      const match = /^(\s*)(exists|unique):/i.exec(part);
      if (!match) {
        return { kind: 'none', start: at, end: at };
      }
      const argsStart = ruleStart + match[0].length;
      if (at < argsStart) {
        return { kind: 'none', start: at, end: at };
      }
      const args = value.slice(argsStart, ruleEnd).split(',');
      let offset = argsStart;
      for (let i = 0; i < args.length; i++) {
        const end = offset + args[i].length;
        if (at >= offset && at <= end) {
          if (i === 0) {
            return { kind: 'table', start: offset, end };
          }
          if (i === 1) {
            const tableArg = args[0].trim();
            const dot = tableArg.indexOf('.');
            return {
              kind: 'column',
              start: offset,
              end,
              connection: dot > 0 ? tableArg.slice(0, dot) : undefined,
              table: dot > 0 ? tableArg.slice(dot + 1) : tableArg,
            };
          }
          return { kind: 'none', start: at, end: at };
        }
        offset = end + 1;
      }
      return { kind: 'none', start: at, end: at };
    }
    ruleStart = ruleEnd + 1;
  }
  return { kind: 'none', start: at, end: at };
}

/** Helper for features: the literal values of a call's arguments. */
export function literalArgs(analyzer: Analyzer, site: CallSite): Array<string | undefined> {
  return callArgs(analyzer.doc, site.open, site.close).map((range) =>
    range[0] === range[1] ? literalValue(analyzer.doc.tok(range[0])) : undefined,
  );
}
