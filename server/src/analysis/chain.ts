/**
 * Syntax around a token: the call (or array property / return) a string literal is an argument
 * of, and method chains (`Root::a(...)->b(...)->c`) read backwards from a token or forwards
 * from a call.
 */
import { isReservedCallName, type PhpDocument } from '../php/document.ts';

export interface ArrayLevel {
  open: number;
  close: number;
  /** The element is the key of `key => value`. Only for the innermost level. */
  isKey: boolean;
  /** The element is the value of `key => value`. */
  isValue: boolean;
  /** The key token of `key => value` when the element is a value. */
  keyTok?: number;
  /** Position of the element within the array (counting commas). */
  elementIndex: number;
}

export interface CallSite {
  type: 'call';
  kind: 'method' | 'static' | 'function' | 'new';
  name: string;
  nameTok: number;
  open: number;
  close: number;
  argIndex: number;
  /** Named argument (`column: 'x'`). */
  argName?: string;
  /** Arrays between the call and the token, innermost first. */
  arrays: ArrayLevel[];
  /** Last token of the receiver: before `->` (method) or the class token (static). */
  receiverEnd: number;
}

export interface PropertySite {
  type: 'property';
  name: string;
  arrays: ArrayLevel[];
  /** Token of the property variable. */
  tok: number;
  /** A `const NAME = …` declaration rather than a property. */
  constant?: boolean;
}

export interface ReturnSite {
  type: 'return';
  arrays: ArrayLevel[];
  tok: number;
}

export type Site = CallSite | PropertySite | ReturnSite;

/** The construct token `tok` is a direct element of (through arrays). */
export function siteOf(doc: PhpDocument, tok: number): Site | undefined {
  const t = doc.tokens;
  const arrays: ArrayLevel[] = [];
  let commas = 0;
  let isValue = false;
  let keyTok: number | undefined;
  let argName: string | undefined;
  // A named argument right before the element: `column: 'x'`
  if (doc.isOp(tok - 1, ':') && t[tok - 2]?.type === 'ident' && doc.isOp(tok - 3, '(', ',')) {
    argName = t[tok - 2].value;
  }

  const finishBoundary = (j: number): Site | undefined => {
    if (arrays.length === 0) {
      return undefined;
    }
    const outer = arrays[arrays.length - 1].open;
    // `protected $fillable = [` / `const X = [`
    if (doc.isOp(outer - 1, '=') && t[outer - 2]?.type === 'var') {
      return { type: 'property', name: t[outer - 2].value, arrays, tok: outer - 2 };
    }
    if (doc.isOp(outer - 1, '=') && t[outer - 2]?.type === 'ident' && doc.isIdent(outer - 3, 'const')) {
      return { type: 'property', name: t[outer - 2].value, arrays, tok: outer - 2, constant: true };
    }
    if (doc.isIdent(outer - 1, 'return') || (doc.isOp(outer - 1, '=>') && doc.isIdent(outer - 2, 'fn'))) {
      return { type: 'return', arrays, tok: outer - 1 };
    }
    void j;
    return undefined;
  };

  let j = tok - 1;
  while (j >= 0) {
    const token = t[j];
    if (token.type === 'op') {
      const value = token.value;
      if (value === ')' || value === ']' || value === '}') {
        const pair = doc.match[j];
        j = pair < 0 ? j - 1 : pair - 1;
        continue;
      }
      if (value === ',') {
        commas++;
        j--;
        continue;
      }
      if (value === '=>') {
        if (commas === 0 && !isValue) {
          isValue = true;
          keyTok = j - 1;
        }
        j--;
        continue;
      }
      if (value === ';') {
        return finishBoundary(j);
      }
      if (value === '{' || value === '#[') {
        return finishBoundary(j);
      }
      if (value === '[' || (value === '(' && doc.isIdent(j - 1, 'array'))) {
        const prev = t[j - 1];
        // `$row['x']`, `foo()['x']`: index access, not an array literal
        if (
          value === '[' &&
          prev &&
          (prev.type === 'var' ||
            prev.type === 'string' ||
            doc.isOp(j - 1, ')', ']', '}') ||
            (prev.type === 'ident' && !isKeywordBeforeArray(prev.value)))
        ) {
          return undefined;
        }
        arrays.push({
          open: j,
          close: doc.match[j],
          isKey: arrays.length === 0 && !isValue && doc.isOp(tok + 1, '=>'),
          isValue,
          keyTok,
          elementIndex: commas,
        });
        commas = 0;
        isValue = false;
        keyTok = undefined;
        j = value === '(' ? j - 2 : j - 1;
        continue;
      }
      if (value === '(') {
        const nameToken = t[j - 1];
        if (nameToken?.type === 'ident' && !isReservedCallName(nameToken.value)) {
          let kind: CallSite['kind'] = 'function';
          let receiverEnd = -1;
          if (doc.isOp(j - 2, '->', '?->')) {
            kind = 'method';
            receiverEnd = j - 3;
          } else if (doc.isOp(j - 2, '::')) {
            kind = 'static';
            receiverEnd = j - 3;
          } else if (doc.isIdent(j - 2, 'new')) {
            kind = 'new';
          }
          if (isValue && arrays.length === 0) {
            // `foo('a' => …)` is not PHP; treat like a plain argument.
            isValue = false;
          }
          return {
            type: 'call',
            kind,
            name: nameToken.value,
            nameTok: j - 1,
            open: j,
            close: doc.match[j],
            argIndex: commas,
            argName: arrays.length === 0 ? argName : undefined,
            arrays,
            receiverEnd,
          };
        }
        return undefined;
      }
    } else if (token.type === 'ident') {
      const word = token.value.toLowerCase();
      if (word === 'return' && arrays.length) {
        return { type: 'return', arrays, tok: j };
      }
    }
    j--;
  }
  return finishBoundary(-1);
}

function isKeywordBeforeArray(word: string): boolean {
  return ['return', 'echo', 'yield', 'in', 'as', 'case', 'print', 'and', 'or', 'xor', 'fn', 'match'].includes(
    word.toLowerCase(),
  );
}

export interface Segment {
  name: string;
  nameTok: number;
  /** Call parentheses; undefined for property access. */
  open?: number;
  close?: number;
  /** `Class::method()` */
  isStatic?: boolean;
}

export type Root =
  | { kind: 'class'; name: string; tok: number }
  | { kind: 'var'; name: string; tok: number }
  | { kind: 'new'; name: string; tok: number }
  | { kind: 'function'; name: string; tok: number; open: number; close: number }
  | { kind: 'unknown' };

export interface Chain {
  root: Root;
  segments: Segment[];
}

/** The chain whose last token is `end` (e.g. the token before `->name(`). */
export function chainEndingAt(doc: PhpDocument, end: number): Chain {
  const t = doc.tokens;
  const segments: Segment[] = [];
  let j = end;
  for (let guard = 0; j >= 0 && guard < 500; guard++) {
    const token = t[j];
    if (doc.isOp(j, ')')) {
      const open = doc.match[j];
      if (open < 0) {
        return { root: { kind: 'unknown' }, segments };
      }
      const nameToken = t[open - 1];
      if (nameToken?.type === 'ident' && !isReservedCallName(nameToken.value)) {
        const segment: Segment = { name: nameToken.value, nameTok: open - 1, open, close: j };
        const before = open - 2;
        if (doc.isOp(before, '->', '?->')) {
          segments.unshift(segment);
          j = before - 1;
          continue;
        }
        if (doc.isOp(before, '::')) {
          segment.isStatic = true;
          segments.unshift(segment);
          const cls = t[before - 1];
          if (cls?.type === 'ident') {
            return { root: { kind: 'class', name: cls.value, tok: before - 1 }, segments };
          }
          if (cls?.type === 'var') {
            return { root: { kind: 'var', name: cls.value, tok: before - 1 }, segments };
          }
          return { root: { kind: 'unknown' }, segments };
        }
        if (doc.isIdent(before, 'new')) {
          return { root: { kind: 'new', name: nameToken.value, tok: open - 1 }, segments };
        }
        return { root: { kind: 'function', name: nameToken.value, tok: open - 1, open, close: j }, segments };
      }
      // `(new Foo)`, `(new Foo())`, `(clone $q)`, `($a ?? $b)`
      if (doc.isIdent(open + 1, 'new') && t[open + 2]?.type === 'ident') {
        return { root: { kind: 'new', name: t[open + 2].value, tok: open + 2 }, segments };
      }
      if (doc.isIdent(open + 1, 'clone')) {
        const inner = chainEndingAt(doc, j - 1);
        return { root: inner.root, segments: [...inner.segments, ...segments] };
      }
      return { root: { kind: 'unknown' }, segments };
    }
    if (token?.type === 'ident') {
      if (doc.isOp(j - 1, '->', '?->')) {
        segments.unshift({ name: token.value, nameTok: j });
        j -= 2;
        continue;
      }
      return { root: { kind: 'class', name: token.value, tok: j }, segments };
    }
    if (token?.type === 'var') {
      return { root: { kind: 'var', name: token.value, tok: j }, segments };
    }
    return { root: { kind: 'unknown' }, segments };
  }
  return { root: { kind: 'unknown' }, segments };
}

/** Calls chained after the call closing at `close`: `->a(...)->b(...)`. */
export function segmentsAfter(doc: PhpDocument, close: number): Segment[] {
  const t = doc.tokens;
  const segments: Segment[] = [];
  let j = close + 1;
  for (let guard = 0; guard < 200; guard++) {
    if (!doc.isOp(j, '->', '?->') || t[j + 1]?.type !== 'ident') {
      break;
    }
    const nameTok = j + 1;
    if (doc.isOp(j + 2, '(')) {
      const end = doc.match[j + 2];
      if (end < 0) {
        segments.push({ name: t[nameTok].value, nameTok, open: j + 2, close: t.length - 1 });
        break;
      }
      segments.push({ name: t[nameTok].value, nameTok, open: j + 2, close: end });
      j = end + 1;
    } else {
      segments.push({ name: t[nameTok].value, nameTok });
      j = nameTok + 1;
    }
  }
  return segments;
}

/** Token ranges [first, last] of the arguments of the call with parentheses open..close. */
export function callArgs(doc: PhpDocument, open: number, close: number): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  const end = close < 0 ? doc.length : close;
  let start = open + 1;
  for (let i = open + 1; i < end; i++) {
    if (doc.isOp(i, '(', '[', '{', '#[')) {
      const pair = doc.match[i];
      if (pair > i) {
        i = pair;
        continue;
      }
    }
    if (doc.isOp(i, ',')) {
      args.push([start, i - 1]);
      start = i + 1;
    }
  }
  if (end > start) {
    args.push([start, end - 1]);
  }
  return args;
}
