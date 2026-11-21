/**
 * The Laravel application on disk: Composer PSR-4 autoloading (project and vendor) to find class
 * files, Eloquent models (table, connection, relations, inheritance, traits), factories, and the
 * migrations that create and alter tables (for go to definition). Files are parsed lazily and
 * cached by modification time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ClassDecl, type FunctionDecl, hasComputedRaw, literalValue, PhpDocument } from '../php/document.ts';
import { tableForModel } from './inflector.ts';
import { type MetaMaps, metaFiles, parseMeta } from './meta.ts';
import { RELATION_TYPES } from './methods.ts';

export interface RelationInfo {
  name: string;
  /** Lower-cased relation constructor, e.g. `hasmany`. */
  type: string;
  /** Related model class. */
  related?: string;
  /**
   * The related class when the definition does not name it directly, resolved per model (late
   * static binding): a property holding the class (`static::$postModel`, `$this->postModel`), or a
   * class path relative to a namespace given to a helper (`model_class('Lists\Post')`).
   */
  relatedRef?: { property?: string; hint?: string; definedIn: string };
  /** Intermediate model of has*Through. */
  through?: string;
  /** belongsToMany / morphToMany pivot table when given. */
  pivotTable?: string;
  /** String literal arguments by position (undefined for non-literals). */
  args: Array<string | undefined>;
}

/** What a local scope (`scopePublished($query)`) does to its query that later clauses rely on. */
export interface LocalScope {
  /** Tables it joins, as written (`posts as p`). */
  joins: string[];
  /** Other methods it calls on the query (lower-cased): scopes it builds on. */
  calls: string[];
  /** Names it selects `as` (`selectRaw('... as distance')`): valid in later clauses. */
  aliases: string[];
  /** It selects SQL built at runtime (`DB::raw(full_name_sql('author'))`): any name may follow. */
  computedSelect: boolean;
  /** Parameter names without `$`, and their literal defaults. */
  params: string[];
  defaults: Array<string | undefined>;
  /** Parameters the caller does not pass: 1 for a local scope's `$query`. */
  argOffset: number;
  /** The parameter naming what it selects (`selectFullName($alias = 'name')`). */
  aliasParam?: number;
}

export interface ModelInfo {
  fqn: string;
  file?: string;
  /** Offset of the class declaration in `file`. */
  offset?: number;
  table: string;
  /** Whether `$table` / `#[Table]` sets it (otherwise derived from the class name). */
  explicitTable: boolean;
  connection?: string;
  primaryKey: string;
  relations: Map<string, RelationInfo>;
  /** Local scopes by lower-cased name without the prefix (`scopePublished` → `published`). */
  scopes: Map<string, LocalScope>;
  /** Its own Eloquent builder class (`newEloquentBuilder()`, `$builder`), if any. */
  builder?: string;
}

/** A class named in code: resolved, or a reference resolved per model / repository. */
export type ClassRef = Pick<RelationInfo, 'related' | 'relatedRef'>;

export interface MethodInfo {
  /** Declared return type (`@return`, else native), class names qualified (`\\App\\User|null`). */
  returnType?: string;
  /** `return $this->other(...)...`: the method its result comes from (lower-cased). */
  delegatesTo?: string;
  /** `$this->setModel(Post::class); return $this->createModel();`: the model it switches to. */
  modelRef?: ClassRef;
  /** Parameter names without `$`, in order. */
  params: string[];
  /** What its body does to `$this` as a query (for builder classes). */
  body: LocalScope;
}

interface ClassInfo {
  fqn: string;
  file: string;
  offset: number;
  kind: string;
  extends?: string;
  traits: string[];
  properties: Map<string, string>;
  /** Class-valued properties, e.g. a factory's `$model = User::class`. */
  classProperties: Map<string, string>;
  tableAttribute?: string;
  connectionAttribute?: string;
  relations: Map<string, RelationInfo>;
  scopes: Map<string, LocalScope>;
  /** Declared property types (`$repository` → `\\App\\Repositories\\UserRepository`), qualified. */
  propertyTypes: Map<string, string>;
  /** Methods by lower-cased name. */
  methods: Map<string, MethodInfo>;
  /** A repository's model: `model()` returning a class, `$this->setModel(...)`, `$model = X::class`. */
  modelRef?: ClassRef;
  /** `newEloquentBuilder()` returning `new GridBuilder($query)`. */
  builderClass?: string;
}

const MODEL_BASES = new Set(
  [
    'Illuminate\\Database\\Eloquent\\Model',
    'Illuminate\\Foundation\\Auth\\User',
    'Illuminate\\Database\\Eloquent\\Relations\\Pivot',
    'Illuminate\\Database\\Eloquent\\Relations\\MorphPivot',
    'Illuminate\\Notifications\\DatabaseNotification',
  ].map((c) => c.toLowerCase()),
);

const FACTORY_BASE = 'illuminate\\database\\eloquent\\factories\\factory';

/** How long a file's modification time is trusted without another stat. */
const STAT_TTL_MS = 1500;

export interface MigrationColumn {
  table: string;
  column: string;
  file: string;
  offset: number;
  method: string;
}

export interface MigrationTable {
  table: string;
  file: string;
  offset: number;
  create: boolean;
}

interface MigrationFile {
  mtime: number;
  tables: MigrationTable[];
  columns: MigrationColumn[];
}

export class LaravelProject {
  readonly root: string;
  private psr4: Array<[string, string[]]> = [];
  private vendorPsr4: Array<[string, string[]]> | undefined;
  /** Per file: every class it declares. */
  private readonly classCache = new Map<string, { mtime: number; checked: number; classes: ClassInfo[] }>();
  /** Classes declared in a file named after another class (lower-cased FQN → file). */
  private readonly secondaryClasses = new Map<string, string>();
  private readonly fileForClass = new Map<string, string | null>();
  private readonly modelCache = new Map<string, ModelInfo | null>();
  private modelCacheAt = 0;
  private migrationPaths: string[];
  private readonly migrationFiles = new Map<string, MigrationFile>();
  private migrationsScannedAt = 0;
  private modelIndex: { at: number; byTable: Map<string, string[]> } | undefined;
  private metaPaths: string[];
  private macroIndex: { at: number; byName: Map<string, LocalScope> } | undefined;
  private metaCache: { checked: number; stamp: string; maps: MetaMaps } | undefined;

  constructor(
    root: string,
    migrationPaths: string[] = ['database/migrations'],
    metaPaths: string[] = ['.phpstorm.meta.php'],
  ) {
    this.root = root;
    this.migrationPaths = migrationPaths;
    this.metaPaths = metaPaths;
    this.loadComposer();
  }

  setMetaPaths(paths: string[]): void {
    this.metaPaths = paths;
    this.metaCache = undefined;
  }

  /** The PhpStorm metadata maps, re-read when a file changes. */
  private meta(): MetaMaps {
    const now = Date.now();
    if (this.metaCache && now - this.metaCache.checked < STAT_TTL_MS) {
      return this.metaCache.maps;
    }
    const files = metaFiles(this.root, this.metaPaths);
    const stamp = files
      .map((file) => {
        try {
          return `${file}:${fs.statSync(file).mtimeMs}`;
        } catch {
          return file;
        }
      })
      .join('|');
    if (this.metaCache?.stamp === stamp) {
      this.metaCache.checked = now;
      return this.metaCache.maps;
    }
    const maps: MetaMaps = new Map();
    for (const file of files) {
      try {
        parseMeta(fs.readFileSync(file, 'utf8'), maps);
      } catch {
        // An unreadable file: the others still count.
      }
    }
    this.metaCache = { checked: now, stamp, maps };
    return maps;
  }

  /**
   * The class `fn('key')` returns by the PhpStorm metadata (`app('cache')`, a project's container
   * helper). Several extensions may bind one key: of the classes found in the project, the one of
   * the shortest root namespace (the base module over its client-specific variants), then by name.
   */
  containerBinding(fn: string, key: string): string | undefined {
    const candidates = this.meta()
      .get(fn.replace(/^\\/, '').toLowerCase())
      ?.get(key)
      ?.filter((cls) => this.classFile(cls) !== undefined);
    if (!candidates?.length) {
      return undefined;
    }
    const root = (cls: string) => cls.split('\\').slice(0, 2).join('\\').length;
    return [...candidates].sort((a, b) => root(a) - root(b) || a.localeCompare(b))[0];
  }

  setMigrationPaths(paths: string[]): void {
    this.migrationPaths = paths;
    this.migrationsScannedAt = 0;
  }

  /** Re-reads composer.json (after it changed). */
  loadComposer(): void {
    this.psr4 = [];
    this.vendorPsr4 = undefined;
    this.fileForClass.clear();
    if (!this.readComposer(this.root)) {
      // Not a Composer project: fall back to the Laravel layout.
      this.psr4.push(['App\\', [path.join(this.root, 'app')]]);
    }
    // Packages developed inside the project (workbench modules, path repositories, monorepos)
    // autoload through their own composer.json; their paths stay under the project root.
    for (const dir of findNestedPackages(this.root)) {
      this.readComposer(dir);
    }
    if (!this.psr4.some(([prefix]) => prefix === 'Database\\Factories\\')) {
      this.psr4.push(['Database\\Factories\\', [path.join(this.root, 'database', 'factories')]]);
    }
    this.psr4.sort((a, b) => b[0].length - a[0].length);
  }

  /** Adds the PSR-4 mappings of `dir/composer.json`; false when there is none. */
  private readComposer(dir: string): boolean {
    let composer: Record<string, Record<string, Record<string, string | string[]>>>;
    try {
      composer = JSON.parse(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8'));
    } catch {
      return false;
    }
    for (const section of ['autoload', 'autoload-dev']) {
      for (const [prefix, dirs] of Object.entries(composer[section]?.['psr-4'] ?? {})) {
        const list = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.join(dir, d));
        this.psr4.push([prefix.replace(/^\\/, ''), list]);
      }
    }
    return true;
  }

  private loadVendorPsr4(): Array<[string, string[]]> {
    if (this.vendorPsr4) {
      return this.vendorPsr4;
    }
    const entries: Array<[string, string[]]> = [];
    try {
      const text = fs.readFileSync(path.join(this.root, 'vendor', 'composer', 'autoload_psr4.php'), 'utf8');
      const vendorDir = path.join(this.root, 'vendor');
      const re = /'((?:[^'\\]|\\.)*)'\s*=>\s*array\(([^)]*)\)/g;
      for (let match = re.exec(text); match; match = re.exec(text)) {
        const prefix = match[1].replace(/\\\\/g, '\\');
        const dirs = [...match[2].matchAll(/\$(vendorDir|baseDir)\s*\.\s*'([^']*)'/g)].map(([, base, rel]) =>
          path.join(base === 'vendorDir' ? vendorDir : this.root, rel),
        );
        entries.push([prefix, dirs]);
      }
    } catch {
      // No vendor directory.
    }
    entries.sort((a, b) => b[0].length - a[0].length);
    this.vendorPsr4 = entries;
    return entries;
  }

  /** File declaring class `fqn` through PSR-4 (project first, then vendor). */
  classFile(fqn: string): string | undefined {
    const name = fqn.replace(/^\\/, '');
    const cached = this.fileForClass.get(name.toLowerCase());
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    let found: string | undefined;
    for (const mapping of [this.psr4, this.loadVendorPsr4()]) {
      for (const [prefix, dirs] of mapping) {
        if (!name.startsWith(prefix)) {
          continue;
        }
        const relative = `${name.slice(prefix.length).replace(/\\/g, '/')}.php`;
        for (const dir of dirs) {
          const file = path.join(dir, relative);
          if (fs.existsSync(file)) {
            found = file;
            break;
          }
        }
        if (found) {
          break;
        }
      }
      if (found) {
        break;
      }
    }
    this.fileForClass.set(name.toLowerCase(), found ?? null);
    return found;
  }

  private classInfo(fqn: string): ClassInfo | undefined {
    const key = fqn.replace(/^\\/, '').toLowerCase();
    const file = this.classFile(fqn) ?? this.secondaryClasses.get(key);
    if (!file) {
      return undefined;
    }
    const classes = this.classesOf(file);
    return classes?.find((c) => c.fqn.toLowerCase() === key) ?? classes?.[0];
  }

  private classesOf(file: string): ClassInfo[] | undefined {
    const now = Date.now();
    const cached = this.classCache.get(file);
    if (cached && now - cached.checked < STAT_TTL_MS) {
      return cached.classes;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      this.classCache.delete(file);
      return undefined;
    }
    if (cached && cached.mtime === mtime) {
      cached.checked = now;
      return cached.classes;
    }
    let classes: ClassInfo[] = [];
    try {
      classes = parseClasses(file, new PhpDocument(fs.readFileSync(file, 'utf8')));
    } catch {
      classes = [];
    }
    this.remember(file, classes, mtime, now);
    return classes;
  }

  private remember(file: string, classes: ClassInfo[], mtime: number, checked: number): void {
    this.classCache.set(file, { mtime, checked, classes });
    for (const info of classes) {
      this.secondaryClasses.set(info.fqn.toLowerCase(), file);
    }
    this.modelCache.clear();
  }

  /** Parses an open (possibly unsaved) document as the source of its class. */
  updateClassFromText(file: string, text: string, parsed?: PhpDocument): void {
    const document = parsed ?? new PhpDocument(text);
    const classes = parseClasses(file, document);
    if (classes.length === 0) {
      return;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    this.remember(file, classes, mtime, Date.now() + 60_000);
  }

  /** Back to the file on disk after an open document closed. */
  dropOverride(file: string): void {
    if (this.classCache.delete(file)) {
      this.modelCache.clear();
    }
  }

  /** Parent chain of a class, nearest first (FQNs, lower-cased), as far as files resolve. */
  private ancestors(fqn: string): string[] {
    const chain: string[] = [];
    let current: string | undefined = fqn;
    for (let depth = 0; current && depth < 12; depth++) {
      const info = this.classInfo(current);
      const parent = info?.extends;
      if (!parent) {
        break;
      }
      chain.push(parent.toLowerCase());
      current = parent;
    }
    return chain;
  }

  isModel(fqn: string): boolean {
    if (MODEL_BASES.has(fqn.toLowerCase())) {
      return true;
    }
    const chain = this.ancestors(fqn);
    if (chain.some((c) => MODEL_BASES.has(c))) {
      return true;
    }
    // Parent outside the resolvable files: trust a model-like base name.
    const last = chain[chain.length - 1];
    const base = last?.split('\\').pop() ?? '';
    return /(model|eloquent|authenticatable|pivot)$/.test(base);
  }

  isFactory(fqn: string): boolean {
    return this.ancestors(fqn).some((c) => c === FACTORY_BASE || c.endsWith('\\factory'));
  }

  /** Eloquent model info, or undefined when `fqn` is not a model. */
  model(fqn: string): ModelInfo | undefined {
    const key = fqn.replace(/^\\/, '').toLowerCase();
    // `Model` itself (a declared `: Model` result) has no table.
    if (MODEL_BASES.has(key)) {
      return undefined;
    }
    const now = Date.now();
    if (now - this.modelCacheAt > STAT_TTL_MS) {
      this.modelCache.clear();
      this.modelCacheAt = now;
    }
    const cached = this.modelCache.get(key);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const info = this.isModel(fqn) ? this.buildModel(fqn.replace(/^\\/, '')) : undefined;
    this.modelCache.set(key, info ?? null);
    return info;
  }

  private buildModel(fqn: string): ModelInfo {
    let table: string | undefined;
    let connection: string | undefined;
    let primaryKey: string | undefined;
    const relations = new Map<string, RelationInfo>();
    const scopes = new Map<string, LocalScope>();
    let builder: string | undefined;
    const own = this.classInfo(fqn);
    /** The class and its ancestors and traits, nearest first: where properties are looked up. */
    const lineage: ClassInfo[] = [];
    let current: string | undefined = fqn;
    for (let depth = 0; current && depth < 12; depth++) {
      const info = this.classInfo(current);
      if (!info) {
        break;
      }
      lineage.push(info);
      table ??= info.tableAttribute ?? info.properties.get('$table');
      connection ??= info.connectionAttribute ?? info.properties.get('$connection');
      primaryKey ??= info.properties.get('$primaryKey');
      const traits = info.traits.map((trait) => this.classInfo(trait)).filter((c): c is ClassInfo => !!c);
      lineage.push(...traits);
      for (const source of [info, ...traits]) {
        builder ??= source.builderClass ?? source.classProperties.get('$builder');
        for (const [name, relation] of source.relations) {
          if (!relations.has(name)) {
            relations.set(name, relation);
          }
        }
        for (const [name, scope] of source.scopes) {
          if (!scopes.has(name)) {
            scopes.set(name, scope);
          }
        }
      }
      current = info.extends;
    }
    for (const [name, relation] of relations) {
      const ref = relation.relatedRef;
      if (relation.related || !ref) {
        continue;
      }
      let related: string | undefined;
      if (ref.property) {
        // `static::$postModel` binds late: this model's own value wins over its parents'.
        for (const info of lineage) {
          const value = info.classProperties.get(ref.property) ?? info.properties.get(ref.property);
          if (value) {
            related = value.replace(/^\\/, '');
            break;
          }
        }
      } else if (ref.hint) {
        related = this.resolveClassHint(ref.hint, ref.definedIn);
      }
      if (related) {
        relations.set(name, { ...relation, related });
      }
    }
    return {
      fqn,
      file: own?.file,
      offset: own?.offset,
      table: table ?? tableForModel(fqn),
      explicitTable: table !== undefined,
      connection,
      primaryKey: primaryKey ?? 'id',
      relations,
      scopes,
      builder,
    };
  }

  /**
   * A model named by a class path relative to a namespace, as runtime helpers take it
   * (`model_class('Lists\Post')`): the nearest `<namespace>\<path>` or `<namespace>\Models\<path>`
   * going up from the namespace of `near`.
   */
  resolveClassHint(hint: string, near: string): string | undefined {
    const name = hint.replace(/^\\/, '');
    if (!/^[A-Za-z_]\w*(\\[A-Za-z_]\w*)*$/.test(name)) {
      return undefined;
    }
    const parts = near.replace(/^\\/, '').split('\\').slice(0, -1);
    for (let n = parts.length; n >= 1; n--) {
      const prefix = parts.slice(0, n).join('\\');
      for (const candidate of [`${prefix}\\${name}`, `${prefix}\\Models\\${name}`]) {
        if (this.classFile(candidate) && this.isModel(candidate)) {
          return candidate;
        }
      }
    }
    return this.classFile(name) && this.isModel(name) ? name : undefined;
  }

  /** Whether `fqn` is, or extends, one of `bases` (lower-cased FQNs). */
  extendsAny(fqn: string, bases: Set<string>): boolean {
    const key = fqn.replace(/^\\/, '').toLowerCase();
    return bases.has(key) || this.ancestors(fqn).some((c) => bases.has(c.replace(/^\\/, '')));
  }

  /**
   * What a builder method we cannot find in Laravel does: a method of the project's builder class
   * `builder`, or a macro (`Builder::macro('name', fn)`) registered in a service provider.
   */
  customMethod(builder: string | undefined, name: string): LocalScope | undefined {
    if (builder) {
      const method = this.methodInfo(builder, name);
      if (method) {
        return method.body;
      }
    }
    return this.macros().get(name.toLowerCase());
  }

  /** Builder macros of the project's (and its packages') service providers. */
  private macros(): Map<string, LocalScope> {
    const now = Date.now();
    if (this.macroIndex && now - this.macroIndex.at < 60_000) {
      return this.macroIndex.byName;
    }
    const byName = new Map<string, LocalScope>();
    for (const [, dirs] of this.psr4) {
      for (const dir of dirs) {
        for (const file of providerFiles(path.join(dir, 'Providers'))) {
          try {
            collectMacros(new PhpDocument(fs.readFileSync(file, 'utf8')), byName);
          } catch {
            // An unreadable provider: the others still count.
          }
        }
      }
    }
    this.macroIndex = { at: now, byName };
    return byName;
  }

  /** Whether a file declares `fqn` (project or vendor). */
  hasClass(fqn: string): boolean {
    return this.classInfo(fqn) !== undefined;
  }

  /** The file and offset of the declaration of `fqn` (project or vendor). */
  classLocation(fqn: string): { file: string; offset: number } | undefined {
    const info = this.classInfo(fqn);
    return info ? { file: info.file, offset: info.offset } : undefined;
  }

  /** The class, its traits, its parents and their traits, nearest first. */
  private lineage(fqn: string): ClassInfo[] {
    const out: ClassInfo[] = [];
    let current: string | undefined = fqn;
    for (let depth = 0; current && depth < 12; depth++) {
      const info = this.classInfo(current);
      if (!info) {
        break;
      }
      out.push(info);
      for (const trait of info.traits) {
        const traitInfo = this.classInfo(trait);
        if (traitInfo) {
          out.push(traitInfo);
        }
      }
      current = info.extends;
    }
    return out;
  }

  /** Declared type of a property (`$users`), qualified, from the class or its ancestors. */
  propertyType(fqn: string, property: string): string | undefined {
    for (const info of this.lineage(fqn)) {
      const type = info.propertyTypes.get(property);
      // `$this->users = container_helper('users')`: resolved by the metadata when asked.
      const container = type ? /^@container (\S+) (.*)$/.exec(type) : undefined;
      if (container) {
        const cls = this.containerBinding(container[1], container[2]);
        if (cls) {
          return `\\${cls}`;
        }
        continue;
      }
      if (type) {
        return type;
      }
    }
    return undefined;
  }

  /** A method's declared return type / delegation, from the class or its ancestors. */
  methodInfo(fqn: string, method: string): MethodInfo | undefined {
    const name = method.toLowerCase();
    for (const info of this.lineage(fqn)) {
      const found = info.methods.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * The model a repository class works on: its (or an ancestor's) `model()` returning a class,
   * `$this->setModel(...)`, or `$model = Post::class`; references resolved like relations'.
   */
  repositoryModel(fqn: string): ModelInfo | undefined {
    const ref = this.lineage(fqn).find((info) => info.modelRef)?.modelRef;
    return ref ? this.modelOfRef(ref, fqn) : undefined;
  }

  /** The model a class reference names, properties looked up on `owner` (late static binding). */
  modelOfRef(ref: ClassRef, owner: string): ModelInfo | undefined {
    let related = ref.related;
    if (!related && ref.relatedRef?.property) {
      const property = ref.relatedRef.property;
      const holder = this.lineage(owner).find((c) => c.classProperties.has(property) || c.properties.has(property));
      related = (holder?.classProperties.get(property) ?? holder?.properties.get(property))?.replace(/^\\/, '');
    } else if (!related && ref.relatedRef?.hint) {
      related = this.resolveClassHint(ref.relatedRef.hint, ref.relatedRef.definedIn);
    }
    return related ? this.model(related) : undefined;
  }

  /** Model of a factory class: `$model` or the naming convention. */
  factoryModel(fqn: string): ModelInfo | undefined {
    const info = this.classInfo(fqn);
    const explicit = info?.classProperties.get('$model');
    if (explicit) {
      return this.model(explicit);
    }
    const base = (fqn.split('\\').pop() ?? '').replace(/Factory$/, '');
    if (!base) {
      return undefined;
    }
    const namespace = fqn
      .split('\\')
      .slice(0, -1)
      .join('\\')
      .replace(/^Database\\Factories\\?/, '');
    for (const candidate of [`App\\Models\\${namespace ? `${namespace}\\` : ''}${base}`, `App\\${base}`]) {
      const model = this.model(candidate);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  /** Follows `posts.comments` from a model; undefined when a step does not resolve. */
  relationPath(model: ModelInfo, relationPath: string): { model?: ModelInfo; relation?: RelationInfo } {
    let current: ModelInfo | undefined = model;
    let relation: RelationInfo | undefined;
    for (const part of relationPath.split('.')) {
      const name = part.split(':')[0].trim();
      relation = current?.relations.get(name.toLowerCase());
      if (!relation) {
        return {};
      }
      current = relation.related ? this.model(relation.related) : undefined;
      if (!current) {
        return { relation };
      }
    }
    return { model: current, relation };
  }

  /** Model classes whose table is `table` (scans the project's PSR-4 directories once a while). */
  modelsForTable(table: string): ModelInfo[] {
    const now = Date.now();
    if (!this.modelIndex || now - this.modelIndex.at > 60_000) {
      this.modelIndex = { at: now, byTable: this.scanModels() };
    }
    return (this.modelIndex.byTable.get(table.toLowerCase()) ?? []).flatMap((fqn) => {
      const model = this.model(fqn);
      return model ? [model] : [];
    });
  }

  private scanModels(): Map<string, string[]> {
    const byTable = new Map<string, string[]>();
    let budget = 4000;
    const visit = (dir: string, prefix: string, depth: number) => {
      if (depth > 8 || budget <= 0) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (budget <= 0) {
          return;
        }
        if (entry.isDirectory()) {
          if (!['vendor', 'node_modules', '.git', 'storage', 'tests'].includes(entry.name)) {
            visit(path.join(dir, entry.name), `${prefix}${entry.name}\\`, depth + 1);
          }
          continue;
        }
        if (!entry.name.endsWith('.php')) {
          continue;
        }
        budget--;
        const file = path.join(dir, entry.name);
        let head = '';
        try {
          head = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!/\bclass\s+\w+\s+extends\s/.test(head)) {
          continue;
        }
        const fqn = `${prefix}${entry.name.slice(0, -4)}`;
        const model = this.model(fqn);
        if (model) {
          const list = byTable.get(model.table.toLowerCase()) ?? [];
          list.push(fqn);
          byTable.set(model.table.toLowerCase(), list);
        }
      }
    };
    for (const [prefix, dirs] of this.psr4) {
      if (prefix.startsWith('Database\\') || prefix.startsWith('Tests\\')) {
        continue;
      }
      for (const dir of dirs) {
        visit(dir, prefix, 0);
      }
    }
    return byTable;
  }

  // --- migrations ------------------------------------------------------------------------

  /** Tables and columns created/altered by the migrations (cached by file modification time). */
  migrations(): MigrationFile[] {
    const now = Date.now();
    if (now - this.migrationsScannedAt > STAT_TTL_MS) {
      this.migrationsScannedAt = now;
      const seen = new Set<string>();
      for (const relative of this.migrationPaths) {
        const dir = path.resolve(this.root, relative);
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir).filter((n) => n.endsWith('.php'));
        } catch {
          continue;
        }
        for (const name of names) {
          const file = path.join(dir, name);
          seen.add(file);
          let mtime = 0;
          try {
            mtime = fs.statSync(file).mtimeMs;
          } catch {
            continue;
          }
          if (this.migrationFiles.get(file)?.mtime === mtime) {
            continue;
          }
          try {
            this.migrationFiles.set(file, { mtime, ...parseMigration(file, fs.readFileSync(file, 'utf8')) });
          } catch {
            this.migrationFiles.delete(file);
          }
        }
      }
      for (const file of [...this.migrationFiles.keys()]) {
        if (!seen.has(file)) {
          this.migrationFiles.delete(file);
        }
      }
    }
    return [...this.migrationFiles.values()];
  }
}

const SKIP_DIRS = new Set([
  'vendor',
  'vendor-bin',
  'node_modules',
  'storage',
  'bootstrap',
  'public',
  '.git',
  '.idea',
  '.direnv',
  '.cache',
  'dist',
  'build',
  'target',
  'tests',
  'resources',
  'lang',
  'database',
  'config',
  'routes',
]);

/**
 * Directories below `root` (symlinks followed, depth <= 4) that hold a composer.json. Bounded so a
 * huge tree cannot stall startup.
 */
export function findNestedPackages(root: string, maxDepth = 4, budget = 4000): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  try {
    seen.add(fs.realpathSync(root));
  } catch {
    return found;
  }
  let queue: string[] = [root];
  for (let depth = 0; depth < maxDepth && queue.length && budget > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (budget-- <= 0) {
          break;
        }
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDir = fs.statSync(full).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (!isDir) {
          continue;
        }
        let real: string;
        try {
          real = fs.realpathSync(full);
        } catch {
          continue;
        }
        if (seen.has(real)) {
          continue;
        }
        seen.add(real);
        if (fs.existsSync(path.join(full, 'composer.json'))) {
          found.push(full);
        }
        next.push(full);
      }
    }
    queue = next;
  }
  return found;
}

/** String literal arguments of an attribute, by position and by name (`key: 'uuid'`). */
function attributeArgs(document: PhpDocument, open: number): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  let position = 0;
  for (const [first, last] of splitArgs(document, open, document.match[open])) {
    const named = document.tok(first)?.type === 'ident' && document.isOp(first + 1, ':');
    const valueTok = named ? first + 2 : first;
    const value = valueTok === last ? literalValue(document.tok(valueTok)) : undefined;
    if (named) {
      out[(document.tok(first)?.value ?? '').toLowerCase()] = value;
    } else {
      out[position] = value;
    }
    position++;
  }
  return out;
}

/** Every named class/trait of a file. */
function parseClasses(file: string, document: PhpDocument): ClassInfo[] {
  return document.classes.flatMap((decl) => (decl.fqn ? [classInfoOf(file, document, decl, decl.fqn)] : []));
}

function classInfoOf(file: string, document: PhpDocument, decl: ClassDecl, fqn: string): ClassInfo {
  const t = document.tokens;
  const info: ClassInfo = {
    fqn,
    file,
    offset: t[decl.keyword].start,
    kind: decl.kind,
    extends: decl.extends,
    traits: [],
    properties: new Map(),
    classProperties: new Map(),
    relations: new Map(),
    scopes: new Map(),
    propertyTypes: new Map(),
    methods: new Map(),
  };

  // Attributes before the class: #[Table('name', key: 'uuid')], #[Connection('name')]
  for (let i = decl.keyword - 1; i >= 0 && i > decl.keyword - 400; i--) {
    if (document.isOp(i, ';', '}')) {
      break;
    }
    if (t[i].type === 'ident' && document.isOp(i + 1, '(') && document.match[i + 1] > i) {
      const name = (t[i].value.split('\\').pop() ?? '').toLowerCase();
      const args = attributeArgs(document, i + 1);
      if (name === 'table') {
        info.tableAttribute = args.name ?? args[0];
        const key = args.key ?? args[1];
        if (key) {
          info.properties.set('$primaryKey', key);
        }
      } else if (name === 'connection' && (args.name ?? args[0])) {
        info.connectionAttribute = args.name ?? args[0];
      }
    }
  }

  let depth = 0;
  for (let i = decl.open + 1; i < decl.close; i++) {
    const token = t[i];
    if (token.type === 'op') {
      if (token.value === '{') {
        depth++;
      } else if (token.value === '}') {
        depth--;
      }
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (token.type === 'ident' && token.value.toLowerCase() === 'use') {
      for (let j = i + 1; j < decl.close && !document.isOp(j, ';', '{'); j++) {
        if (t[j].type === 'ident') {
          info.traits.push(document.resolveClass(t[j].value));
        }
      }
      continue;
    }
    if (token.type === 'var') {
      const type = declaredPropertyType(document, i, token.value, decl);
      if (type && !info.propertyTypes.has(token.value)) {
        info.propertyTypes.set(token.value, type);
      }
    }
    if (token.type === 'var' && document.isOp(i + 1, '=') && t[i - 1]?.type === 'ident') {
      const value = literalValue(t[i + 2]);
      if (value !== undefined && document.isOp(i + 3, ';')) {
        info.properties.set(token.value, value);
      } else if (t[i + 2]?.type === 'ident' && document.isOp(i + 3, '::') && document.isIdent(i + 4, 'class')) {
        info.classProperties.set(token.value, document.resolveClass(t[i + 2].value));
      }
    }
  }

  for (const fn of document.functions) {
    if (fn.kind !== 'method' || !fn.name || fn.bodyStart < decl.open || fn.bodyEnd > decl.close) {
      continue;
    }
    const relation = relationOf(document, fn.bodyStart, fn.bodyEnd, fn.name, info.fqn);
    if (relation) {
      info.relations.set(fn.name.toLowerCase(), relation);
    }
    const scopeName = /^scope([A-Z_]\w*)$/.exec(fn.name)?.[1];
    if (scopeName) {
      info.scopes.set(scopeName.toLowerCase(), localScopeOf(document, fn));
    }
    info.methods.set(fn.name.toLowerCase(), methodInfoOf(document, fn, decl));
    if (fn.name.toLowerCase() === 'neweloquentbuilder') {
      for (let j = fn.bodyStart; j > 0 && j < fn.bodyEnd; j++) {
        if (document.isIdent(j, 'new') && t[j + 1]?.type === 'ident') {
          info.builderClass = document.resolveClass(t[j + 1].value);
          break;
        }
      }
    }
    collectMembers(document, fn, info, decl);
  }
  // A repository that only sets its model in methods (`grid()`): the first one.
  info.modelRef ??= [...info.methods.values()].find((m) => m.modelRef)?.modelRef;
  info.modelRef ??= info.classProperties.has('$model')
    ? { related: info.classProperties.get('$model') }
    : info.properties.get('$model')?.includes('\\')
      ? { related: info.properties.get('$model')?.replace(/^\\/, '') }
      : undefined;
  return info;
}

const BUILTIN_TYPES = new Set(
  'null array int integer string mixed bool boolean void callable float double iterable object false true never resource'.split(
    ' ',
  ),
);

/** A type as written, with class names qualified (`?User|Builder` → `?\\App\\Models\\User|\\…\\Builder`). */
function qualifyType(document: PhpDocument, type: string, decl: ClassDecl): string {
  return type.replace(/\$this|\\?[A-Za-z_][\w\\]*/g, (name) => {
    const lower = name.toLowerCase();
    if (BUILTIN_TYPES.has(lower)) {
      return name;
    }
    if (lower === 'static' || lower === 'self' || lower === '$this') {
      return 'static';
    }
    if (lower === 'parent') {
      return decl.extends ? `\\${decl.extends}` : name;
    }
    return `\\${document.resolveClass(name)}`;
  });
}

const MODIFIERS = new Set(['public', 'protected', 'private', 'var', 'static', 'readonly']);

/**
 * Type of a property declared at token `i` (`private UserRepository $users;`, a promoted
 * constructor parameter, or `@var` above it); undefined when `i` is not a property.
 */
function declaredPropertyType(document: PhpDocument, i: number, name: string, decl: ClassDecl): string | undefined {
  const t = document.tokens;
  let j = i - 1;
  while (
    j > decl.open &&
    (t[j].type === 'ident' || document.isOp(j, '?', '|', '&')) &&
    !MODIFIERS.has(t[j].value.toLowerCase())
  ) {
    j--;
  }
  if (t[j]?.type !== 'ident' || !MODIFIERS.has(t[j].value.toLowerCase())) {
    return undefined;
  }
  const native = t
    .slice(j + 1, i)
    .map((token) => token.value)
    .join('');
  let first = j;
  while (first > decl.open && t[first - 1].type === 'ident' && MODIFIERS.has(t[first - 1].value.toLowerCase())) {
    first--;
  }
  const docs = document.docsBetween(first - 1, i);
  const doc = docs.length ? docVarType(docs[docs.length - 1].value, name) : undefined;
  const type = doc ?? (native || undefined);
  return type ? qualifyType(document, type, decl) : undefined;
}

/** `@var Type $name` or a bare `@var Type`. */
function docVarType(doc: string, name: string): string | undefined {
  const named = new RegExp(`@var\\s+([^\\s*]+)\\s+\\$${name.slice(1)}\\b`).exec(doc);
  if (named) {
    return named[1];
  }
  const bare = /@var\s+([^\s*$]+)\s*(\*\/|\n)/.exec(doc);
  return bare?.[1];
}

function methodInfoOf(document: PhpDocument, fn: FunctionDecl, decl: ClassDecl): MethodInfo {
  const t = document.tokens;
  const info: MethodInfo = { params: fn.params.map((p) => p.name.slice(1)), body: localScopeOf(document, fn, 0) };
  let native = '';
  if (document.isOp(fn.paramsClose + 1, ':')) {
    for (let j = fn.paramsClose + 2; j < t.length && !document.isOp(j, '{', ';'); j++) {
      native += t[j].value;
    }
  }
  const doc = fn.doc ? /@return\s+([^\s*]+)/.exec(fn.doc)?.[1] : undefined;
  const type = doc ?? (native || undefined);
  if (type && !/^\??mixed$/i.test(type)) {
    info.returnType = qualifyType(document, type, decl);
  }
  for (let j = fn.bodyStart; j > 0 && j < fn.bodyEnd; j++) {
    if (document.isIdent(j, 'return') && document.enclosingFunctions(j)[0] === fn) {
      if (
        t[j + 1]?.value === '$this' &&
        document.isOp(j + 2, '->') &&
        t[j + 3]?.type === 'ident' &&
        document.isOp(j + 4, '(')
      ) {
        info.delegatesTo = t[j + 3].value.toLowerCase();
      }
      break;
    }
  }
  return info;
}

/**
 * What a method body tells about the class: a repository's model (`model()` returning a class,
 * `$this->setModel(...)`), and property types from assignments (`$this->users = app(UserRepository::class)`).
 */
function collectMembers(document: PhpDocument, fn: FunctionDecl, info: ClassInfo, decl: ClassDecl): void {
  const t = document.tokens;
  if (fn.bodyStart < 0) {
    return;
  }
  const statementEnd = (from: number) => {
    let end = from;
    while (end + 1 < fn.bodyEnd && !document.isOp(end + 1, ';')) {
      end = document.isOp(end + 1, '(', '[', '{') && document.match[end + 1] > end ? document.match[end + 1] : end + 1;
    }
    return end;
  };
  for (let j = fn.bodyStart; j < fn.bodyEnd; j++) {
    if (fn.name?.toLowerCase() === 'model' && document.isIdent(j, 'return') && !info.modelRef) {
      const ref = classReference(document, j + 1, statementEnd(j + 1), info.fqn, fn.bodyStart, j);
      if (ref.related || ref.relatedRef) {
        info.modelRef = ref;
      }
    }
    if (t[j].value !== '$this' || !document.isOp(j + 1, '->') || t[j + 2]?.type !== 'ident') {
      continue;
    }
    if (t[j + 2].value.toLowerCase() === 'setmodel' && document.isOp(j + 3, '(')) {
      const close = document.match[j + 3];
      const arg = close > j + 4 ? splitArgs(document, j + 3, close)[0] : undefined;
      const ref = arg ? classReference(document, arg[0], arg[1], info.fqn, fn.bodyStart, j) : {};
      if (ref.related || ref.relatedRef) {
        // The constructor sets the repository's model; another method switches it for its result.
        const method = info.methods.get(fn.name?.toLowerCase() ?? '');
        if (fn.name?.toLowerCase() === '__construct') {
          info.modelRef ??= ref;
        } else if (method && !method.modelRef) {
          method.modelRef = ref;
        }
      }
      continue;
    }
    // $this->users = app(UserRepository::class) / new UserRepository / $users (a typed parameter)
    const property = `$${t[j + 2].value}`;
    if (!document.isOp(j + 3, '=') || info.propertyTypes.has(property)) {
      continue;
    }
    const type = assignedType(document, j + 4, statementEnd(j + 4), fn, decl);
    if (type) {
      info.propertyTypes.set(property, type);
    }
  }
}

function assignedType(
  document: PhpDocument,
  s: number,
  e: number,
  fn: FunctionDecl,
  decl: ClassDecl,
): string | undefined {
  const t = document.tokens;
  if (document.isIdent(s, 'new') && t[s + 1]?.type === 'ident') {
    return qualifyType(document, t[s + 1].value, decl);
  }
  if (t[s]?.type === 'ident' && /^\\?(app|resolve)$/i.test(t[s].value) && document.isOp(s + 1, '(')) {
    const ref = classReference(document, s + 2, document.match[s + 1] - 1, decl.fqn ?? '', fn.bodyStart, s);
    if (ref.related) {
      return `\\${ref.related}`;
    }
  }
  if (t[s]?.type === 'var' && s === e) {
    const param = fn.params.find((p) => p.name === t[s].value);
    return param?.type ? qualifyType(document, param.type, decl) : undefined;
  }
  // helper('key'): a container helper the PhpStorm metadata may map; resolved later
  const key = literalValue(t[s + 2]);
  if (t[s]?.type === 'ident' && document.isOp(s + 1, '(') && key && document.isOp(s + 3, ')', ',')) {
    return `@container ${t[s].value.replace(/^\\/, '')} ${key}`;
  }
  return undefined;
}

/** PHP files of a `Providers` directory and its subdirectories (one level). */
function providerFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.php')) {
      files.push(full);
    } else if (entry.isDirectory()) {
      for (const sub of fs.readdirSync(full)) {
        if (sub.endsWith('.php')) {
          files.push(path.join(full, sub));
        }
      }
    }
  }
  return files;
}

/** `Builder::macro('name', function (...) {...})`, or a closure in a variable assigned before. */
function collectMacros(document: PhpDocument, into: Map<string, LocalScope>): void {
  const t = document.tokens;
  for (let i = 0; i + 3 < t.length; i++) {
    if (
      t[i].type !== 'ident' ||
      !/Builder$/i.test(t[i].value) ||
      !document.isOp(i + 1, '::') ||
      !document.isIdent(i + 2, 'macro') ||
      !document.isOp(i + 3, '(')
    ) {
      continue;
    }
    const close = document.match[i + 3];
    const args = close > 0 ? splitArgs(document, i + 3, close) : [];
    const name = literalValue(t[args[0]?.[0] ?? -1]);
    if (!name || !args[1] || into.has(name.toLowerCase())) {
      continue;
    }
    let start = args[1][0];
    if (t[start]?.type === 'var' && args[1][0] === args[1][1]) {
      // `$macro = function (...) {...}; Builder::macro('name', $macro);`
      const variable = t[start].value;
      for (let p = i - 1; p >= 0; p--) {
        if (t[p].type === 'var' && t[p].value === variable && document.isOp(p + 1, '=')) {
          start = p + 2;
          break;
        }
      }
    }
    const fn = document.functions.find((f) => f.start === start || f.keyword === start);
    if (fn) {
      into.set(name.toLowerCase(), localScopeOf(document, fn, 0));
    }
  }
}

const JOINS = new Set(['join', 'leftjoin', 'rightjoin', 'crossjoin', 'joinwhere', 'leftjoinwhere', 'rightjoinwhere']);

/** Joins and method calls in a local scope's own body (not in closures it passes on). */
function localScopeOf(document: PhpDocument, fn: FunctionDecl, argOffset = 1): LocalScope {
  const t = document.tokens;
  const params = fn.params.map((p) => p.name.slice(1));
  const scope: LocalScope = {
    joins: [],
    calls: [],
    aliases: [],
    computedSelect: false,
    params,
    defaults: fn.params.map((p) => (document.isOp(p.tok + 1, '=') ? literalValue(t[p.tok + 2]) : undefined)),
    argOffset,
  };
  const alias = params.findIndex((name, i) => i >= argOffset && /^(alias|as)$|_alias$|[a-z]Alias$/.test(name));
  if (alias >= 0) {
    scope.aliasParam = alias;
  }
  if (fn.bodyStart < 0) {
    return scope;
  }
  for (let j = fn.bodyStart; j < fn.bodyEnd; j++) {
    const text = literalValue(t[j]);
    if (text) {
      for (const match of text.matchAll(/\bas\s+[`"']?(\w+)/gi)) {
        scope.aliases.push(match[1].toLowerCase());
      }
    }
    if (!document.isOp(j, '->') || t[j + 1]?.type !== 'ident' || !document.isOp(j + 2, '(')) {
      continue;
    }
    if (document.enclosingFunctions(j)[0] !== fn) {
      continue;
    }
    const method = t[j + 1].value.toLowerCase();
    if (/^(select|addselect|selectraw)$/.test(method)) {
      const close = document.match[j + 2];
      const raw = method === 'selectraw' && !(close === j + 4 && literalValue(t[j + 3]) !== undefined);
      scope.computedSelect ||= raw || (close > j && hasComputedRaw(document, j + 2, close));
    }
    const table = JOINS.has(method) ? literalValue(t[j + 3]) : undefined;
    if (table) {
      scope.joins.push(table);
    } else if (!JOINS.has(method)) {
      scope.calls.push(method);
    }
  }
  return scope;
}

/**
 * The class the expression [s, e] names: `Post::class`, a class string, a property holding it
 * (`static::$postModel`, `$this->postModel`), a helper given a class path (`model_class('Post')`),
 * or a variable assigned in [from, before).
 */
function classReference(
  document: PhpDocument,
  s: number,
  e: number,
  definedIn: string,
  from: number,
  before: number,
  depth = 0,
): ClassRef {
  const t = document.tokens;
  const [a, c] = [t[s], t[s + 2]];
  if (a?.type === 'ident' && document.isOp(s + 1, '::') && c?.value.toLowerCase() === 'class') {
    return { related: document.resolveClass(a.value) };
  }
  // static::$postModel, self::$postModel, $this->postModel
  if (a?.type === 'ident' && /^(static|self)$/i.test(a.value) && document.isOp(s + 1, '::') && c?.type === 'var') {
    return { relatedRef: { property: c.value, definedIn } };
  }
  if (a?.type === 'var' && a.value === '$this' && document.isOp(s + 1, '->') && c?.type === 'ident' && s + 2 === e) {
    return { relatedRef: { property: `$${c.value}`, definedIn } };
  }
  // model_class('Lists\Post'): a helper resolving a class path at runtime
  const hint = literalValue(c);
  if (a?.type === 'ident' && document.isOp(s + 1, '(') && hint && document.isOp(s + 3, ')') && s + 3 === e) {
    return { relatedRef: { hint, definedIn } };
  }
  // `$postModel = model_class('Post'); return $this->hasMany($postModel)`: its last assignment
  if (a?.type === 'var' && s === e && depth === 0) {
    for (let p = before - 1; p >= from; p--) {
      if (t[p].type === 'var' && t[p].value === a.value && document.isOp(p + 1, '=') && !document.isOp(p - 1, '->')) {
        let end = p + 2;
        while (end < before && !document.isOp(end + 1, ';')) {
          end++;
        }
        return classReference(document, p + 2, end, definedIn, from, before, depth + 1);
      }
    }
    return {};
  }
  const literal = s === e ? literalValue(a) : undefined;
  return literal?.includes('\\') || (literal && /^[A-Z]/.test(literal)) ? { related: literal.replace(/^\\/, '') } : {};
}

/** `return $this->hasMany(Post::class, 'user_id')` inside a method body. */
function relationOf(
  document: PhpDocument,
  from: number,
  to: number,
  name: string,
  definedIn: string,
): RelationInfo | undefined {
  const t = document.tokens;
  for (let i = from; i < to; i++) {
    if (!(t[i].type === 'var' && t[i].value === '$this' && document.isOp(i + 1, '->'))) {
      continue;
    }
    const method = t[i + 2];
    if (method?.type !== 'ident' || !RELATION_TYPES.has(method.value.toLowerCase()) || !document.isOp(i + 3, '(')) {
      continue;
    }
    const open = i + 3;
    const close = document.match[open];
    // Named arguments (`related: Post::class`) are taken positionally: Laravel's order.
    const args = splitArgs(document, open, close < 0 ? to : close).map(([s, e]): [number, number] =>
      t[s]?.type === 'ident' && document.isOp(s + 1, ':') && s + 2 <= e ? [s + 2, e] : [s, e],
    );
    const classArg = (k: number): ClassRef =>
      args[k] ? classReference(document, args[k][0], args[k][1], definedIn, from, i) : {};
    const type = method.value.toLowerCase();
    const relation: RelationInfo = {
      name,
      type,
      ...(type === 'morphto' ? {} : classArg(0)),
      args: args.map((range) => (range[0] === range[1] ? literalValue(t[range[0]]) : undefined)),
    };
    if (type === 'hasonethrough' || type === 'hasmanythrough') {
      relation.through = classArg(1).related;
    }
    if (type === 'belongstomany') {
      relation.pivotTable = relation.args[1];
    }
    if (type === 'morphtomany' || type === 'morphedbymany') {
      relation.pivotTable = relation.args[2];
    }
    return relation;
  }
  return undefined;
}

/** Token ranges [first, last] of the arguments between `open` and `close`. */
export function splitArgs(document: PhpDocument, open: number, close: number): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (document.isOp(i, '(', '[', '{', '#[')) {
      const pair = document.match[i];
      if (pair > i) {
        i = pair;
      }
      continue;
    }
    if (document.isOp(i, ',')) {
      if (i > start) {
        args.push([start, i - 1]);
      }
      start = i + 1;
    }
  }
  if (close > start) {
    args.push([start, close - 1]);
  }
  return args;
}

/** `Schema::create('users', function (Blueprint $table) { $table->string('name'); })` */
function parseMigration(file: string, text: string): { tables: MigrationTable[]; columns: MigrationColumn[] } {
  const document = new PhpDocument(text);
  const t = document.tokens;
  const tables: MigrationTable[] = [];
  const columns: MigrationColumn[] = [];
  for (let i = 0; i < t.length; i++) {
    const token = t[i];
    if (token.type !== 'ident') {
      continue;
    }
    const method = token.value.toLowerCase();
    if (
      (method !== 'create' && method !== 'table') ||
      !document.isOp(i + 1, '(') ||
      !document.isOp(i - 1, '::', '->')
    ) {
      continue;
    }
    // Schema::create / Schema::connection(...)->create
    let k = i - 2;
    if (document.isOp(k, ')')) {
      k = document.match[k] - 2;
      if (!document.isOp(k + 1, '::') && !document.isOp(k + 1, '->')) {
        continue;
      }
    }
    const root = t[k]?.value.split('\\').pop()?.toLowerCase();
    if (root !== 'schema') {
      continue;
    }
    const tableToken = t[i + 2];
    const table = literalValue(tableToken);
    if (!table || !tableToken) {
      continue;
    }
    tables.push({ table, file, offset: tableToken.start, create: method === 'create' });
    const close = document.match[i + 1];
    const fn = document.functions.find((f) => f.keyword > i && f.keyword < close);
    if (!fn || fn.bodyStart < 0) {
      continue;
    }
    const variable = fn.params[0]?.name ?? '$table';
    for (let j = fn.bodyStart; j < fn.bodyEnd; j++) {
      if (t[j].type === 'var' && t[j].value === variable && document.isOp(j + 1, '->') && document.isOp(j + 3, '(')) {
        const columnToken = t[j + 4];
        const column = literalValue(columnToken);
        const name = t[j + 2].value;
        if (column && columnToken && !/^(drop|rename|index|unique|primary|foreign)/i.test(name)) {
          columns.push({ table, column, file, offset: columnToken.start, method: name });
        }
      }
    }
  }
  return { tables, columns };
}
