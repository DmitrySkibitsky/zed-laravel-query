/**
 * Structure of a PHP file on top of the token stream: bracket pairs, namespace and imports,
 * classes, functions/closures with their parameters. Built once per document version; every
 * analysis (completion, hover, diagnostics) works on it.
 */
import { bladeToPhp } from './blade.ts';
import { isStringToken, type StringToken, type Token, tokenize } from './lexer.ts';

export interface Param {
  name: string;
  /** Type declaration as written, e.g. `Builder`, `?User`, `Builder|Relation`. */
  type?: string;
  tok: number;
}

export interface FunctionDecl {
  kind: 'function' | 'method' | 'closure' | 'arrow';
  name?: string;
  /** Index of `function` / `fn`. */
  keyword: number;
  /** First token of the expression (`static`, attributes excluded). */
  start: number;
  paramsOpen: number;
  paramsClose: number;
  params: Param[];
  /** Variables imported with `use (...)`. */
  useVars: string[];
  /** Token range of the body: `{` … `}` (inclusive) or the arrow expression. -1 when abstract. */
  bodyStart: number;
  bodyEnd: number;
  /** Doc comment right before the declaration. */
  doc?: string;
}

export interface ClassDecl {
  kind: 'class' | 'trait' | 'interface' | 'enum';
  name?: string;
  fqn?: string;
  /** Resolved parent class name (no leading backslash). */
  extends?: string;
  keyword: number;
  open: number;
  close: number;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '#[': ']' };
const CLOSERS = new Set([')', ']', '}']);

const RESERVED_CALLS = new Set([
  'if',
  'elseif',
  'while',
  'for',
  'foreach',
  'switch',
  'match',
  'array',
  'list',
  'isset',
  'unset',
  'empty',
  'function',
  'fn',
  'return',
  'echo',
  'print',
  'catch',
  'declare',
  'exit',
  'die',
  'eval',
  'include',
  'require',
  'include_once',
  'require_once',
  'and',
  'or',
  'xor',
]);

export function isReservedCallName(name: string): boolean {
  return RESERVED_CALLS.has(name.toLowerCase());
}

export class PhpDocument {
  readonly text: string;
  readonly tokens: Token[];
  /** Doc comments (`/** … *\/`), in order. */
  readonly docs: Token[];
  /** For a bracket token index: the index of its pair, -1 when unbalanced or not a bracket. */
  readonly match: Int32Array;
  namespace = '';
  /** Lower-cased alias → fully qualified class name (no leading backslash). */
  readonly uses = new Map<string, string>();
  readonly classes: ClassDecl[] = [];
  readonly functions: FunctionDecl[] = [];

  constructor(text: string, options: { blade?: boolean; startInPhp?: boolean } = {}) {
    this.text = options.blade ? bladeToPhp(text) : text;
    const all = tokenize(this.text, { startInPhp: options.blade || options.startInPhp });
    this.tokens = [];
    this.docs = [];
    for (const token of all) {
      if (token.type === 'doc') {
        this.docs.push(token);
      } else {
        this.tokens.push(token);
      }
    }
    this.match = new Int32Array(this.tokens.length).fill(-1);
    this.matchBrackets();
    this.scan();
  }

  get length(): number {
    return this.tokens.length;
  }

  tok(i: number): Token | undefined {
    return i >= 0 && i < this.tokens.length ? this.tokens[i] : undefined;
  }

  /** Whether token `i` is the operator `value`. */
  isOp(i: number, ...values: string[]): boolean {
    const token = this.tok(i);
    return token?.type === 'op' && values.includes(token.value);
  }

  isIdent(i: number, value?: string): boolean {
    const token = this.tok(i);
    return token?.type === 'ident' && (value === undefined || token.value.toLowerCase() === value);
  }

  stringAt(i: number): StringToken | undefined {
    const token = this.tok(i);
    return isStringToken(token) ? token : undefined;
  }

  /** Index of the first token whose end is >= offset (binary search). */
  private lowerBound(offset: number): number {
    let lo = 0;
    let hi = this.tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tokens[mid].end < offset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** The string token whose content contains `offset` (cursor positions included). */
  stringIndexAt(offset: number): number {
    const i = this.lowerBound(offset);
    for (const j of [i, i - 1, i + 1]) {
      const token = this.stringAt(j);
      if (token && offset >= token.contentStart && offset <= token.contentEnd) {
        return j;
      }
    }
    return -1;
  }

  /** Index of the last token that starts before `offset`. */
  indexBefore(offset: number): number {
    let lo = 0;
    let hi = this.tokens.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.tokens[mid].start < offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** Resolves a class name as written in this file (imports, namespace) to its FQN. */
  resolveClass(name: string): string {
    if (name.startsWith('\\')) {
      return name.slice(1);
    }
    const lower = name.toLowerCase();
    if (lower === 'namespace' || lower.startsWith('namespace\\')) {
      return this.join(this.namespace, name.slice('namespace\\'.length));
    }
    const slash = name.indexOf('\\');
    const head = (slash < 0 ? name : name.slice(0, slash)).toLowerCase();
    const imported = this.uses.get(head);
    if (imported) {
      return slash < 0 ? imported : `${imported}${name.slice(slash)}`;
    }
    return this.join(this.namespace, name);
  }

  private join(namespace: string, name: string): string {
    return namespace ? `${namespace}\\${name}` : name;
  }

  /** Functions/closures whose body contains token `i`, innermost first. */
  enclosingFunctions(i: number): FunctionDecl[] {
    return this.functions
      .filter((f) => f.bodyStart >= 0 && i > f.bodyStart - (f.kind === 'arrow' ? 1 : 0) && i <= f.bodyEnd)
      .sort((a, b) => b.bodyStart - a.bodyStart);
  }

  /** Functions whose parameter list contains token `i`. */
  functionWithParamsAt(i: number): FunctionDecl | undefined {
    return this.functions.find((f) => i > f.paramsOpen && i < f.paramsClose);
  }

  enclosingClass(i: number): ClassDecl | undefined {
    let best: ClassDecl | undefined;
    for (const c of this.classes) {
      if (i > c.open && i < c.close && (!best || c.open > best.open)) {
        best = c;
      }
    }
    return best;
  }

  /** The function a closure/arrow literal starting at token `i` declares. */
  functionStartingAt(i: number): FunctionDecl | undefined {
    return this.functions.find((f) => f.start === i || f.keyword === i);
  }

  /** The doc comment that ends right before token `i` (only whitespace/modifiers between). */
  docBefore(i: number): string | undefined {
    const token = this.tok(i);
    if (!token) {
      return undefined;
    }
    const prevEnd = i > 0 ? this.tokens[i - 1].end : 0;
    for (let d = this.docs.length - 1; d >= 0; d--) {
      const doc = this.docs[d];
      if (doc.end <= token.start && doc.start >= prevEnd) {
        return doc.value;
      }
      if (doc.end < prevEnd) {
        break;
      }
    }
    return undefined;
  }

  /** Doc comments located inside the token range [from, to]. */
  docsBetween(from: number, to: number): Token[] {
    const start = this.tok(from)?.start ?? 0;
    const end = this.tok(to)?.end ?? this.text.length;
    return this.docs.filter((d) => d.start >= start && d.end <= end);
  }

  /**
   * End (inclusive) of the expression starting at token `from`: stops before a `,` `;` `=>`
   * (when `stopAtArrow`) at depth 0, or before a closer of an enclosing bracket.
   */
  expressionEnd(from: number, stopAtArrow = false): number {
    let i = from;
    for (; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.type === 'op') {
        const value = token.value;
        if (OPENERS[value] !== undefined) {
          const pair = this.match[i];
          if (pair < 0) {
            return this.tokens.length - 1;
          }
          i = pair;
          continue;
        }
        if (CLOSERS.has(value) || value === ',' || value === ';' || (stopAtArrow && value === '=>')) {
          return i - 1;
        }
      }
    }
    return this.tokens.length - 1;
  }

  /** Start (inclusive) of the expression/statement that ends at token `to`, scanning backwards. */
  statementStart(to: number): number {
    let i = to;
    for (; i >= 0; i--) {
      const token = this.tokens[i];
      if (token.type === 'op') {
        const value = token.value;
        if (CLOSERS.has(value)) {
          const pair = this.match[i];
          if (pair < 0) {
            return i + 1;
          }
          i = pair;
          continue;
        }
        if (OPENERS[value] !== undefined || value === ';' || value === ',') {
          return i + 1;
        }
      }
    }
    return 0;
  }

  private matchBrackets(): void {
    const stack: number[] = [];
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.type !== 'op') {
        continue;
      }
      if (OPENERS[token.value] !== undefined) {
        stack.push(i);
      } else if (CLOSERS.has(token.value)) {
        // Recover from a missing closer: pop until the matching kind.
        for (let s = stack.length - 1; s >= 0; s--) {
          const open = stack[s];
          if (OPENERS[this.tokens[open].value] === token.value) {
            this.match[open] = i;
            this.match[i] = open;
            stack.length = s;
            break;
          }
        }
      }
    }
  }

  private scan(): void {
    const t = this.tokens;
    // Brace depth and the classes being inside, to tell methods from functions in one pass.
    let depth = 0;
    const classStack: Array<{ close: number; bodyDepth: number }> = [];
    for (let i = 0; i < t.length; i++) {
      const token = t[i];
      while (classStack.length && i > classStack[classStack.length - 1].close) {
        classStack.pop();
      }
      if (token.type === 'op') {
        if (token.value === '{') {
          depth++;
        } else if (token.value === '}') {
          depth--;
        }
        continue;
      }
      if (token.type !== 'ident') {
        continue;
      }
      const word = token.value.toLowerCase();
      if (word === 'namespace' && this.isIdentLike(i + 1) && !this.isOp(i + 1, '\\')) {
        if (!this.isOp(i - 1, '->', '?->', '::')) {
          this.namespace = t[i + 1].value.replace(/^\\/, '');
        }
        continue;
      }
      // Imports; not trait `use` inside a class, not closure `use (...)`.
      if (word === 'use' && !this.isOp(i + 1, '(') && classStack.length === 0) {
        i = this.scanUse(i);
        continue;
      }
      if (
        (word === 'class' || word === 'trait' || word === 'interface' || word === 'enum') &&
        !this.isOp(i - 1, '::', '->', '?->')
      ) {
        const decl = this.scanClass(i);
        if (decl) {
          this.classes.push(decl);
          classStack.push({ close: decl.close, bodyDepth: depth + 1 });
        }
        continue;
      }
      if (word === 'function' || word === 'fn') {
        const inClassBody = classStack.length > 0 && classStack[classStack.length - 1].bodyDepth === depth;
        const decl = this.scanFunction(i, inClassBody);
        if (decl) {
          this.functions.push(decl);
        }
      }
    }
  }

  private isIdentLike(i: number): boolean {
    return this.tok(i)?.type === 'ident';
  }

  private scanUse(i: number): number {
    const t = this.tokens;
    let j = i + 1;
    if (this.isIdent(j, 'function') || this.isIdent(j, 'const')) {
      while (j < t.length && !this.isOp(j, ';')) {
        j++;
      }
      return j;
    }
    // use A\B\C [as D], E\F;  use A\B\{C, D as E};
    while (j < t.length && !this.isOp(j, ';')) {
      const name = t[j];
      if (name.type !== 'ident') {
        j++;
        continue;
      }
      let prefix = name.value.replace(/^\\/, '');
      if (this.isOp(j + 1, '\\') && this.isOp(j + 2, '{')) {
        prefix = prefix.replace(/\\$/, '');
        const close = this.match[j + 2];
        let k = j + 3;
        while (k < (close < 0 ? t.length : close)) {
          if (t[k].type === 'ident') {
            const full = `${prefix}\\${t[k].value}`;
            let alias = t[k].value.split('\\').pop() ?? t[k].value;
            if (this.isIdent(k + 1, 'as') && this.tok(k + 2)?.type === 'ident') {
              alias = t[k + 2].value;
              k += 2;
            }
            this.uses.set(alias.toLowerCase(), full);
          }
          k++;
        }
        j = close < 0 ? t.length : close + 1;
        continue;
      }
      let alias = prefix.split('\\').pop() ?? prefix;
      if (this.isIdent(j + 1, 'as') && this.tok(j + 2)?.type === 'ident') {
        alias = t[j + 2].value;
        j += 2;
      }
      this.uses.set(alias.toLowerCase(), prefix);
      j++;
    }
    return j;
  }

  private scanClass(i: number): ClassDecl | undefined {
    const t = this.tokens;
    const kind = t[i].value.toLowerCase() as ClassDecl['kind'];
    let j = i + 1;
    let name: string | undefined;
    if (this.tok(j)?.type === 'ident' && !['extends', 'implements'].includes(t[j].value.toLowerCase())) {
      name = t[j].value;
      j++;
    } else if (kind !== 'class' || !this.isIdent(i - 1, 'new')) {
      // `class` used as a constant (`Foo::class`) is excluded by the caller; anything else
      // without a name is not a declaration.
      if (!this.isOp(j, '(') && !this.isIdent(j, 'extends') && !this.isIdent(j, 'implements')) {
        return undefined;
      }
    }
    if (this.isOp(j, '(')) {
      j = this.match[j] < 0 ? j + 1 : this.match[j] + 1;
    }
    let parent: string | undefined;
    while (j < t.length && !this.isOp(j, '{')) {
      if (this.isIdent(j, 'extends') && this.tok(j + 1)?.type === 'ident') {
        parent = this.resolveClass(t[j + 1].value);
      }
      if (this.isOp(j, ';')) {
        return undefined;
      }
      j++;
    }
    if (!this.isOp(j, '{')) {
      return undefined;
    }
    const close = this.match[j] < 0 ? t.length - 1 : this.match[j];
    return {
      kind,
      name,
      fqn: name ? (this.namespace ? `${this.namespace}\\${name}` : name) : undefined,
      extends: parent,
      keyword: i,
      open: j,
      close,
    };
  }

  private scanFunction(i: number, inClassBody: boolean): FunctionDecl | undefined {
    const t = this.tokens;
    const isArrow = t[i].value.toLowerCase() === 'fn';
    let j = i + 1;
    if (this.isOp(j, '&')) {
      j++;
    }
    let name: string | undefined;
    if (!isArrow && this.tok(j)?.type === 'ident') {
      name = t[j].value;
      j++;
    }
    if (!this.isOp(j, '(')) {
      return undefined;
    }
    const paramsOpen = j;
    const paramsClose = this.match[j];
    if (paramsClose < 0) {
      return undefined;
    }
    const params = this.scanParams(paramsOpen, paramsClose);
    j = paramsClose + 1;
    const useVars: string[] = [];
    if (this.isIdent(j, 'use') && this.isOp(j + 1, '(')) {
      const close = this.match[j + 1];
      for (let k = j + 2; k < close; k++) {
        if (t[k].type === 'var') {
          useVars.push(t[k].value);
        }
      }
      j = close < 0 ? j + 2 : close + 1;
    }
    // Return type
    let bodyStart = -1;
    let bodyEnd = -1;
    if (isArrow) {
      while (j < t.length && !this.isOp(j, '=>') && !this.isOp(j, ';', '{')) {
        j++;
      }
      if (this.isOp(j, '=>')) {
        bodyStart = j + 1;
        bodyEnd = this.expressionEnd(bodyStart);
      }
    } else {
      while (j < t.length && !this.isOp(j, '{', ';')) {
        j++;
      }
      if (this.isOp(j, '{')) {
        bodyStart = j;
        bodyEnd = this.match[j] < 0 ? t.length - 1 : this.match[j];
      }
    }
    let start = i;
    if (this.isIdent(i - 1, 'static')) {
      start = i - 1;
    }
    let declStart = start;
    while (declStart > 0 && this.tok(declStart - 1)?.type === 'ident' && isModifier(t[declStart - 1].value)) {
      declStart--;
    }
    const kind: FunctionDecl['kind'] = isArrow ? 'arrow' : name ? (inClassBody ? 'method' : 'function') : 'closure';
    return {
      kind,
      name,
      keyword: i,
      start,
      paramsOpen,
      paramsClose,
      params,
      useVars,
      bodyStart,
      bodyEnd,
      doc: this.docBefore(declStart),
    };
  }

  private scanParams(open: number, close: number): Param[] {
    const t = this.tokens;
    const params: Param[] = [];
    let typeParts: string[] = [];
    for (let k = open + 1; k < close; k++) {
      const token = t[k];
      if (this.isOp(k, '(', '[', '#[')) {
        const pair = this.match[k];
        if (pair > k) {
          k = pair;
        }
        continue;
      }
      if (token.type === 'var') {
        const type = typeParts.filter((p) => !isModifier(p)).join('') || undefined;
        params.push({ name: token.value, type, tok: k });
        typeParts = [];
        // Skip the default value
        while (k + 1 < close && !this.isOp(k + 1, ',')) {
          k++;
          const pair = this.match[k];
          if (this.isOp(k, '(', '[', '{') && pair > k) {
            k = pair;
          }
        }
        continue;
      }
      if (this.isOp(k, ',')) {
        typeParts = [];
        continue;
      }
      if (token.type === 'ident' || this.isOp(k, '?', '|', '&')) {
        if (this.isOp(k, '&') && t[k + 1]?.type === 'var') {
          continue;
        }
        typeParts.push(token.value);
      }
    }
    return params;
  }
}

const MODIFIERS = new Set([
  'public',
  'protected',
  'private',
  'static',
  'abstract',
  'final',
  'readonly',
  'function',
  'var',
]);

function isModifier(word: string): boolean {
  return MODIFIERS.has(word.toLowerCase());
}

/** Plain string value of a token: a non-interpolated string literal, else undefined. */
export function literalValue(token: Token | undefined): string | undefined {
  if (!isStringToken(token) || token.interpolated) {
    return undefined;
  }
  return token.value;
}

/**
 * `DB::raw(...)` / `->raw(...)` in (open, close) whose SQL is not a plain string, unless its
 * string parts still name the alias (`DB::raw("'" . $kind . "' as kind")`).
 */
export function hasComputedRaw(doc: PhpDocument, open: number, close: number): boolean {
  for (let i = open + 1; i < close; i++) {
    const token = doc.tok(i);
    if (
      token?.type === 'ident' &&
      token.value.toLowerCase() === 'raw' &&
      doc.isOp(i - 1, '::', '->') &&
      doc.isOp(i + 1, '(')
    ) {
      const end = doc.match[i + 1];
      if (end === i + 3 && literalValue(doc.tok(i + 2)) !== undefined) {
        continue;
      }
      let named = false;
      for (let j = i + 2; j < end; j++) {
        named ||= /\bas\s+[`"']?\w+[`"']?\s*$/i.test(literalValue(doc.tok(j)) ?? '');
      }
      if (!named) {
        return true;
      }
    }
  }
  return false;
}
