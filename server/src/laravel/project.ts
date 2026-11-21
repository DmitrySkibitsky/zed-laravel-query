/**
 * The Laravel application on disk: Composer PSR-4 autoloading (project and vendor) to find class
 * files, Eloquent models (table, connection, relations, inheritance, traits), factories, and the
 * migrations that create and alter tables (for go to definition). Files are parsed lazily and
 * cached by modification time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ClassDecl, literalValue, PhpDocument } from '../php/document.ts';
import { tableForModel } from './inflector.ts';
import { RELATION_TYPES } from './methods.ts';

export interface RelationInfo {
  name: string;
  /** Lower-cased relation constructor, e.g. `hasmany`. */
  type: string;
  /** Related model class. */
  related?: string;
  /** Intermediate model of has*Through. */
  through?: string;
  /** belongsToMany / morphToMany pivot table when given. */
  pivotTable?: string;
  /** String literal arguments by position (undefined for non-literals). */
  args: Array<string | undefined>;
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

  constructor(root: string, migrationPaths: string[] = ['database/migrations']) {
    this.root = root;
    this.migrationPaths = migrationPaths;
    this.loadComposer();
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
    const own = this.classInfo(fqn);
    let current: string | undefined = fqn;
    for (let depth = 0; current && depth < 12; depth++) {
      const info = this.classInfo(current);
      if (!info) {
        break;
      }
      table ??= info.tableAttribute ?? info.properties.get('$table');
      connection ??= info.connectionAttribute ?? info.properties.get('$connection');
      primaryKey ??= info.properties.get('$primaryKey');
      for (const [name, relation] of info.relations) {
        if (!relations.has(name)) {
          relations.set(name, relation);
        }
      }
      for (const trait of info.traits) {
        const traitInfo = this.classInfo(trait);
        for (const [name, relation] of traitInfo?.relations ?? []) {
          if (!relations.has(name)) {
            relations.set(name, relation);
          }
        }
      }
      current = info.extends;
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
    };
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
    const relation = relationOf(document, fn.bodyStart, fn.bodyEnd, fn.name);
    if (relation) {
      info.relations.set(fn.name.toLowerCase(), relation);
    }
  }
  return info;
}

/** `return $this->hasMany(Post::class, 'user_id')` inside a method body. */
function relationOf(document: PhpDocument, from: number, to: number, name: string): RelationInfo | undefined {
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
    const args = splitArgs(document, open, close < 0 ? to : close);
    const classArg = (k: number): string | undefined => {
      const arg = args[k];
      if (!arg) {
        return undefined;
      }
      const [a, b, c] = [t[arg[0]], t[arg[0] + 1], t[arg[0] + 2]];
      if (a?.type === 'ident' && b?.type === 'op' && b.value === '::' && c?.value.toLowerCase() === 'class') {
        return document.resolveClass(a.value);
      }
      const literal = literalValue(a);
      return literal ? literal.replace(/^\\/, '') : undefined;
    };
    const type = method.value.toLowerCase();
    const relation: RelationInfo = {
      name,
      type,
      related: type === 'morphto' ? undefined : classArg(0),
      args: args.map((range) => (range[0] === range[1] ? literalValue(t[range[0]]) : undefined)),
    };
    if (type === 'hasonethrough' || type === 'hasmanythrough') {
      relation.through = classArg(1);
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
