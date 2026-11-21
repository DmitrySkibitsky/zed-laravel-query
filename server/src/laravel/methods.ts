/**
 * What the string arguments of Laravel's database methods mean, per receiver kind.
 *
 * Each spec is a list of `<kind><argument index>[+]` codes, `+` meaning "this argument and every
 * one after it" (variadic):
 *   c  column (also inside an array of columns: `select(['a', 'b'])`)
 *   k  column as array key (`where(['a' => 1])`, `create([...])`)
 *   t  table             r  relation of the model      n  connection name
 *   i  index name (an array there lists columns)      o  comparison operator
 *   p  pivot table column (belongsToMany)
 */

export type ArgKind = 'column' | 'keyColumn' | 'table' | 'relation' | 'connection' | 'index' | 'operator' | 'pivot';

export interface ArgRule {
  kind: ArgKind;
  index: number;
  variadic: boolean;
}

export type MethodCatalog = Map<string, ArgRule[]>;

const KINDS: Record<string, ArgKind> = {
  c: 'column',
  k: 'keyColumn',
  t: 'table',
  r: 'relation',
  n: 'connection',
  i: 'index',
  o: 'operator',
  p: 'pivot',
};

function catalog(spec: Record<string, string>): MethodCatalog {
  const out: MethodCatalog = new Map();
  for (const [names, codes] of Object.entries(spec)) {
    const rules = codes
      .split(/\s+/)
      .filter(Boolean)
      .map((code) => {
        const match = /^([cktrniop])(\d+)(\+?)$/.exec(code);
        if (!match) {
          throw new Error(`bad method spec ${names}: ${code}`);
        }
        return { kind: KINDS[match[1]], index: Number(match[2]), variadic: match[3] === '+' };
      });
    for (const name of names.split(/\s+/)) {
      out.set(name.toLowerCase(), rules);
    }
  }
  return out;
}

/** Joins of a relation path (kirschbaum-development/eloquent-power-joins). */
export const POWER_JOINS =
  'joinRelationship leftJoinRelationship rightJoinRelationship joinRelationshipUsingAlias leftJoinRelationshipUsingAlias rightJoinRelationshipUsingAlias';

/** Query builder, Eloquent builder, relations, join clauses, models (static and instance). */
export const BUILDER_METHODS = catalog({
  'select addSelect distinct groupBy': 'c0+',
  from: 't0',
  'join leftJoin rightJoin crossJoin': 't0 c1 o2 c3',
  'joinWhere leftJoinWhere rightJoinWhere': 't0 c1 o2',
  'joinSub leftJoinSub rightJoinSub': 'c2 o3 c4',
  'on orOn': 'c0 o1 c2',
  'where orWhere whereNot orWhereNot firstWhere': 'c0 k0 o1',
  'whereColumn orWhereColumn': 'c0 o1 c1 c2',
  'whereIn orWhereIn whereNotIn orWhereNotIn whereIntegerInRaw orWhereIntegerInRaw whereIntegerNotInRaw orWhereIntegerNotInRaw':
    'c0',
  'whereNull orWhereNull whereNotNull orWhereNotNull': 'c0',
  'whereBetween orWhereBetween whereNotBetween orWhereNotBetween': 'c0',
  'whereBetweenColumns orWhereBetweenColumns whereNotBetweenColumns orWhereNotBetweenColumns': 'c0 c1',
  'whereValueBetween orWhereValueBetween whereValueNotBetween orWhereValueNotBetween': 'c1',
  'whereDate orWhereDate whereTime orWhereTime whereDay orWhereDay whereMonth orWhereMonth whereYear orWhereYear':
    'c0 o1',
  'wherePast orWherePast whereFuture orWhereFuture whereNowOrPast orWhereNowOrPast whereNowOrFuture orWhereNowOrFuture':
    'c0',
  'whereToday orWhereToday whereBeforeToday orWhereBeforeToday whereAfterToday orWhereAfterToday whereTodayOrBefore orWhereTodayOrBefore whereTodayOrAfter orWhereTodayOrAfter':
    'c0',
  'whereLike orWhereLike whereNotLike orWhereNotLike': 'c0',
  'whereRowValues orWhereRowValues': 'c0 o1',
  'whereJsonContains orWhereJsonContains whereJsonDoesntContain orWhereJsonDoesntContain whereJsonContainsKey orWhereJsonContainsKey whereJsonDoesntContainKey orWhereJsonDoesntContainKey whereJsonOverlaps orWhereJsonOverlaps whereJsonDoesntOverlap orWhereJsonDoesntOverlap':
    'c0',
  'whereJsonLength orWhereJsonLength': 'c0 o1',
  'whereFullText orWhereFullText': 'c0',
  'whereAll orWhereAll whereAny orWhereAny whereNone orWhereNone': 'c0 o1',
  'having orHaving': 'c0 o1',
  'havingNull orHavingNull havingNotNull orHavingNotNull havingBetween orHavingBetween': 'c0',
  'orderBy orderByDesc latest oldest reorder reorderDesc': 'c0',
  'forPageBeforeId forPageAfterId': 'c2',
  'find findOrFail findOr findMany findOrNew': 'c1',
  'first firstOrFail sole value soleValue get getCountForPagination': 'c0',
  'paginate simplePaginate cursorPaginate': 'c1',
  pluck: 'c0 c1',
  'implode count min max sum avg average': 'c0',
  'aggregate numericAggregate': 'c1',
  'insert insertOrIgnore insertGetId': 'k0',
  'insertUsing insertOrIgnoreUsing': 'c0',
  upsert: 'k0 c1 c2',
  'update updateFrom updateQuietly forceFill fill fillable incrementEach decrementEach withCasts': 'k0',
  'updateOrInsert updateOrCreate firstOrCreate firstOrNew createOrFirst incrementOrCreate': 'k0 k1',
  'create createQuietly forceCreate forceCreateQuietly make newModelInstance': 'k0',
  'increment decrement incrementQuietly decrementQuietly': 'c0',
  'chunkById chunkByIdDesc eachById': 'c2',
  'lazyById lazyByIdDesc': 'c1',
  'getAttribute setAttribute getOriginal getRawOriginal getAttributeValue': 'c0',
  'isDirty isClean wasChanged only makeHidden makeVisible setHidden setVisible mergeFillable mergeGuarded': 'c0+',
  'with without withOnly withCount withExists load loadMissing loadCount loadExists': 'r0+',
  'withMax withMin withSum withAvg withAggregate loadMax loadMin loadSum loadAvg loadAggregate': 'r0',
  'has orHas doesntHave orDoesntHave': 'r0 o1',
  'whereHas orWhereHas whereDoesntHave orWhereDoesntHave withWhereHas whereHasMorph orWhereHasMorph whereDoesntHaveMorph orWhereDoesntHaveMorph':
    'r0',
  'whereRelation orWhereRelation whereDoesntHaveRelation orWhereDoesntHaveRelation': 'r0 o2',
  'whereMorphRelation orWhereMorphRelation': 'r0',
  'wherePivot orWherePivot wherePivotNot orWherePivotNot wherePivotIn orWherePivotIn wherePivotNotIn orWherePivotNotIn wherePivotNull orWherePivotNull wherePivotNotNull orWherePivotNotNull wherePivotBetween orWherePivotBetween':
    'p0',
  'withPivot orderByPivot': 'p0+',
  [POWER_JOINS]: 'r0',
  onConnection: 'n0',
});

/** Columns of the related model given as the second argument (`whereRelation('posts', 'title')`). */
export const RELATED_COLUMN_METHODS = new Set(
  [
    'whereRelation',
    'orWhereRelation',
    'whereDoesntHaveRelation',
    'orWhereDoesntHaveRelation',
    'withMax',
    'withMin',
    'withSum',
    'withAvg',
    'withAggregate',
    'loadMax',
    'loadMin',
    'loadSum',
    'loadAvg',
    'loadAggregate',
  ].map((m) => m.toLowerCase()),
);

/** `DB` facade / connection object. */
export const DB_METHODS = catalog({
  'table query': 't0',
  connection: 'n0',
});

/** `Schema` facade / schema builder. Column arguments refer to the table argument. */
export const SCHEMA_METHODS = catalog({
  'create table drop dropIfExists hasTable hasView getColumnListing getColumns getIndexes getIndexListing getForeignKeys rename':
    't0',
  'hasColumn hasColumns getColumnType whenTableHasColumn whenTableDoesntHaveColumn dropColumns': 't0 c1',
  hasIndex: 't0 i1',
  connection: 'n0',
});

/** `Blueprint $table` methods. Column type methods only name existing columns when altering. */
export const BLUEPRINT_METHODS = catalog({
  'dropColumn dropColumns dropConstrainedForeignId': 'c0+',
  renameColumn: 'c0',
  'dropIndex dropUnique dropPrimary dropForeign dropFullText dropSpatialIndex renameIndex': 'i0',
  'index unique primary fullText spatialIndex foreign rawIndex': 'c0',
  after: 'c0',
  'on constrained': 't0',
  references: 'c0+',
});

/** Column definitions that name a column: they refer to existing ones in `Schema::table`. */
export const BLUEPRINT_COLUMN_TYPES = new Set(
  [
    'bigIncrements',
    'bigInteger',
    'binary',
    'boolean',
    'char',
    'date',
    'dateTime',
    'dateTimeTz',
    'decimal',
    'double',
    'enum',
    'float',
    'foreignId',
    'foreignUlid',
    'foreignUuid',
    'geography',
    'geometry',
    'id',
    'increments',
    'integer',
    'integerIncrements',
    'ipAddress',
    'json',
    'jsonb',
    'longText',
    'macAddress',
    'mediumIncrements',
    'mediumInteger',
    'mediumText',
    'set',
    'smallIncrements',
    'smallInteger',
    'softDeletes',
    'softDeletesTz',
    'string',
    'text',
    'time',
    'timeTz',
    'timestamp',
    'timestampTz',
    'tinyIncrements',
    'tinyInteger',
    'tinyText',
    'unsignedBigInteger',
    'unsignedInteger',
    'unsignedMediumInteger',
    'unsignedSmallInteger',
    'unsignedTinyInteger',
    'ulid',
    'uuid',
    'vector',
    'year',
  ].map((m) => m.toLowerCase()),
);

/** Database assertions of Laravel's TestCase (also in Pest closures). */
export const TEST_METHODS = catalog({
  'assertDatabaseHas assertDatabaseMissing assertSoftDeleted assertNotSoftDeleted': 't0 k1',
  'assertDatabaseCount assertDatabaseEmpty assertDeleted': 't0',
});

/** `Rule::exists()` / `Rule::unique()` and their fluent where clauses. */
export const RULE_STATIC_METHODS = catalog({ 'exists unique': 't0 c1' });
export const RULE_METHODS = catalog({
  'where whereNot whereNull whereNotNull whereIn whereNotIn withoutTrashed onlyTrashed': 'c0',
  'ignore ignoreModel': 'c1',
});

export const OPERATORS = [
  '=',
  '<',
  '>',
  '<=',
  '>=',
  '<>',
  '!=',
  '<=>',
  'like',
  'like binary',
  'not like',
  'ilike',
  'not ilike',
  'rlike',
  'not rlike',
  'regexp',
  'not regexp',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '&~',
  '~',
  '~*',
  '!~',
  '!~*',
  'similar to',
  'not similar to',
  '~~*',
  '!~~*',
];

/** Closure kinds: what a closure passed to a builder method receives. */
export type ClosureKind = 'nested' | 'join' | 'relationJoin' | 'relation' | 'subquery' | 'chunk' | 'schema' | 'when';

const CLOSURES: Record<string, string> = {
  nested:
    'where orWhere whereNot orWhereNot having orHaving whereNested addNestedWhereQuery tap whereAny orWhereAny whereAll orWhereAll',
  when: 'when unless',
  join: 'join leftJoin rightJoin crossJoin joinWhere leftJoinWhere rightJoinWhere',
  // kirschbaum-development/eloquent-power-joins
  relationJoin: `${POWER_JOINS}`,
  relation:
    'whereHas orWhereHas whereDoesntHave orWhereDoesntHave has orHas doesntHave orDoesntHave withWhereHas with withCount withExists withMax withMin withSum withAvg withAggregate load loadMissing loadCount loadMax loadMin loadSum loadAvg whereHasMorph orWhereHasMorph whereDoesntHaveMorph orWhereDoesntHaveMorph whereRelation orWhereRelation',
  subquery:
    'whereExists orWhereExists whereNotExists orWhereNotExists whereIn orWhereIn whereNotIn orWhereNotIn selectSub fromSub joinSub leftJoinSub rightJoinSub union unionAll insertUsing addSelect select',
  chunk: 'chunk chunkById chunkByIdDesc each eachById lazy lazyById cursor chunkMap',
};

const CLOSURE_KINDS = new Map<string, ClosureKind>();
for (const [kind, names] of Object.entries(CLOSURES)) {
  for (const name of names.split(/\s+/)) {
    CLOSURE_KINDS.set(name.toLowerCase(), kind as ClosureKind);
  }
}

export function closureKind(method: string): ClosureKind | undefined {
  return CLOSURE_KINDS.get(method.toLowerCase());
}

/** Builder, model and relation methods taking no column names: nothing unknown happens in them. */
const PLAIN_METHODS = new Set(
  `query newQuery toSql toRawSql dd dump ddRawSql dumpRawSql distinct limit take skip offset forPage
  withTrashed onlyTrashed withoutTrashed lockForUpdate sharedLock whereRaw orWhereRaw havingRaw orHavingRaw
  orderByRaw groupByRaw selectRaw fromRaw inRandomOrder exists doesntExist existsOr doesntExistOr cursor
  toBase getQuery getModel withoutGlobalScopes withoutGlobalScope withGlobalScope clone setModel setQuery
  applyScopes delete forceDelete restore touch save push refresh fresh replicate toArray toJson getKey
  getTable getConnection hydrate associate dissociate attach detach sync syncWithoutDetaching toggle
  updateExistingPivot getRelated getParent getResults withTimestamps as using withDefault latestOfMany
  oldestOfMany ofMany one chaperone inverse whereKey whereKeyNot orWhereKey`
    .split(/\s+/)
    .map((m) => m.toLowerCase()),
);

/** A method of Laravel's builders, models or relations (not a macro, a scope or a project method). */
export function isLaravelQueryMethod(method: string): boolean {
  const name = method.toLowerCase();
  return BUILDER_METHODS.has(name) || CLOSURE_KINDS.has(name) || TERMINAL_METHODS.has(name) || PLAIN_METHODS.has(name);
}

/** Model methods taking attribute names: accessors and appended attributes too, not only columns. */
export const ATTRIBUTE_METHODS = new Set(
  `getAttribute setAttribute getOriginal getRawOriginal getAttributeValue isDirty isClean wasChanged only
  makeHidden makeVisible setHidden setVisible mergeFillable mergeGuarded append setAppends`
    .split(/\s+/)
    .map((m) => m.toLowerCase()),
);

/** Methods that run the query: the chain continues on a collection or a model. */
export const TERMINAL_METHODS = new Set(
  [
    'get',
    'all',
    'paginate',
    'simplePaginate',
    'cursorPaginate',
    'cursor',
    'lazy',
    'pluck',
    'keyBy',
    'toArray',
    'collect',
  ].map((m) => m.toLowerCase()),
);

/** Model attributes named in class properties: `$fillable = ['name']`. */
export const MODEL_COLUMN_PROPERTIES = new Set([
  '$fillable',
  '$guarded',
  '$hidden',
  '$visible',
  '$dates',
  '$casts',
  '$attributes',
  '$primaryKey',
  '$encryptable',
  '$searchable',
  '$sortable',
]);

/** Model properties listing relations. */
export const MODEL_RELATION_PROPERTIES = new Set(['$with', '$withCount', '$touches']);

/** Eloquent relation constructors, for relation definitions in models. */
export const RELATION_TYPES = new Set(
  [
    'hasOne',
    'hasMany',
    'belongsTo',
    'belongsToMany',
    'hasOneThrough',
    'hasManyThrough',
    'morphOne',
    'morphMany',
    'morphTo',
    'morphToMany',
    'morphedByMany',
  ].map((m) => m.toLowerCase()),
);

export function rulesFor(catalogs: MethodCatalog, method: string): ArgRule[] | undefined {
  return catalogs.get(method.toLowerCase());
}

/** Kinds that apply to argument `index`. */
export function kindsAt(rules: ArgRule[] | undefined, index: number): ArgKind[] {
  if (!rules) {
    return [];
  }
  const kinds: ArgKind[] = [];
  for (const rule of rules) {
    if (rule.index === index || (rule.variadic && index >= rule.index)) {
      kinds.push(rule.kind);
    }
  }
  return kinds;
}
