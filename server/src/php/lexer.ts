/**
 * A small, error-tolerant PHP tokenizer. It only needs to be good enough to follow method chains,
 * closures and string literals: unterminated strings end at the end of the input, unknown
 * characters become single-character operators, and nothing ever throws.
 *
 * Offsets are UTF-16 code units (JavaScript string indices), the same unit LSP positions use.
 */

export type TokenType = 'ident' | 'var' | 'string' | 'number' | 'op' | 'doc';

export interface Token {
  type: TokenType;
  /** Start offset (inclusive). */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /**
   * `ident`: the name with namespace separators (`\App\Models\User`); `var`: the name with `$`;
   * `op`: the operator text; `string`: the unescaped content; `doc`: the comment text.
   */
  value: string;
}

export interface StringToken extends Token {
  type: 'string';
  /** `'`, `"`, `<<<` (heredoc) or `<<<'` (nowdoc). */
  quote: string;
  /** Offsets of the content between the quotes. */
  contentStart: number;
  contentEnd: number;
  closed: boolean;
  /** A double-quoted or heredoc string with `$var` / `{$expr}` parts: not a plain literal. */
  interpolated: boolean;
}

export function isStringToken(token: Token | undefined): token is StringToken {
  return token?.type === 'string';
}

export interface LexOptions {
  /** Start in PHP code instead of inline HTML (masked Blade, snippets in tests). */
  startInPhp?: boolean;
}

const OPERATORS = [
  '<<=',
  '>>=',
  '**=',
  '...',
  '<=>',
  '===',
  '!==',
  '??=',
  '?->',
  '->',
  '=>',
  '::',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '.=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '#[',
];

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 0x80;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

const SINGLE_ESCAPES: Record<string, string> = { '\\': '\\', "'": "'" };
const DOUBLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  v: '\v',
  e: '\x1b',
  f: '\f',
  '\\': '\\',
  $: '$',
  '"': '"',
};

export function tokenize(text: string, options: LexOptions = {}): Token[] {
  const tokens: Token[] = [];
  const length = text.length;
  let i = 0;
  let inPhp = options.startInPhp ?? false;

  const push = (token: Token) => {
    tokens.push(token);
  };

  while (i < length) {
    if (!inPhp) {
      const open = text.indexOf('<?', i);
      if (open < 0) {
        break;
      }
      if (text.startsWith('<?php', open)) {
        i = open + 5;
      } else if (text.startsWith('<?=', open)) {
        i = open + 3;
        // `<?= expr ?>` behaves like `echo expr;`
        push({ type: 'ident', start: open, end: i, value: 'echo' });
      } else {
        i = open + 2;
      }
      inPhp = true;
      continue;
    }

    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i++;
      continue;
    }
    const ch = text[i];

    // Close tag: back to inline HTML, acts as a statement end.
    if (ch === '?' && text[i + 1] === '>') {
      push({ type: 'op', start: i, end: i + 2, value: ';' });
      i += 2;
      inPhp = false;
      continue;
    }

    // Comments
    if ((ch === '/' && text[i + 1] === '/') || (ch === '#' && text[i + 1] !== '[')) {
      let j = i;
      while (j < length && text[j] !== '\n' && !(text[j] === '?' && text[j + 1] === '>')) {
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? length : close + 2;
      if (text[i + 2] === '*' && text[i + 3] !== '/') {
        push({ type: 'doc', start: i, end, value: text.slice(i, end) });
      }
      i = end;
      continue;
    }

    // Variables
    if (ch === '$' && i + 1 < length && isIdentStart(text.charCodeAt(i + 1))) {
      let j = i + 2;
      while (j < length && isIdentPart(text.charCodeAt(j))) {
        j++;
      }
      push({ type: 'var', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }

    // Identifiers and (qualified) names
    if (isIdentStart(code) || (ch === '\\' && i + 1 < length && isIdentStart(text.charCodeAt(i + 1)))) {
      let j = i;
      for (;;) {
        if (text[j] === '\\') {
          j++;
        }
        while (j < length && isIdentPart(text.charCodeAt(j))) {
          j++;
        }
        if (text[j] === '\\' && j + 1 < length && isIdentStart(text.charCodeAt(j + 1))) {
          continue;
        }
        break;
      }
      push({ type: 'ident', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers
    if (isDigit(code) || (ch === '.' && isDigit(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < length && (isIdentPart(text.charCodeAt(j)) || text[j] === '.')) {
        j++;
      }
      push({ type: 'number', start: i, end: j, value: text.slice(i, j) });
      i = j;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"') {
      const token = readQuoted(text, i, ch);
      push(token);
      i = token.end;
      continue;
    }
    if (text.startsWith('<<<', i)) {
      const token = readHeredoc(text, i);
      if (token) {
        push(token);
        i = token.end;
        continue;
      }
    }

    // Casts such as (int) are just tokens; operators by longest match.
    let op = ch;
    for (const candidate of OPERATORS) {
      if (text.startsWith(candidate, i)) {
        op = candidate;
        break;
      }
    }
    push({ type: 'op', start: i, end: i + op.length, value: op });
    i += op.length;
  }

  return tokens;
}

function readQuoted(text: string, start: number, quote: string): StringToken {
  const length = text.length;
  let j = start + 1;
  let value = '';
  let interpolated = false;
  let closed = false;
  const escapes = quote === "'" ? SINGLE_ESCAPES : DOUBLE_ESCAPES;
  while (j < length) {
    const c = text[j];
    if (c === quote) {
      closed = true;
      break;
    }
    if (c === '\\' && j + 1 < length) {
      const next = text[j + 1];
      const escaped = escapes[next];
      if (escaped !== undefined) {
        value += escaped;
      } else {
        value += c + next;
      }
      j += 2;
      continue;
    }
    if (quote === '"' && c === '$' && j + 1 < length && (isIdentStart(text.charCodeAt(j + 1)) || text[j + 1] === '{')) {
      interpolated = true;
    }
    if (quote === '"' && c === '{' && text[j + 1] === '$') {
      interpolated = true;
    }
    value += c;
    j++;
  }
  const contentEnd = j;
  const end = closed ? j + 1 : j;
  return {
    type: 'string',
    start,
    end,
    value,
    quote,
    contentStart: start + 1,
    contentEnd,
    closed,
    interpolated,
  };
}

function readHeredoc(text: string, start: number): StringToken | undefined {
  const header = /^<<<[ \t]*(['"]?)([A-Za-z_\x80-￿][\w\x80-￿]*)\1\r?\n/.exec(text.slice(start, start + 256));
  if (!header) {
    return undefined;
  }
  const nowdoc = header[1] === "'";
  const label = header[2];
  const contentStart = start + header[0].length;
  // The closing label: on its own line, optionally indented, followed by a non-identifier char.
  const closing = new RegExp(`(^|\\n)([ \\t]*)${label}(?![\\w\\x80-\\uffff])`, 'g');
  closing.lastIndex = contentStart - 1;
  let match: RegExpExecArray | null = closing.exec(text);
  while (match && match.index + match[1].length < contentStart) {
    match = closing.exec(text);
  }
  const contentEnd = match ? match.index : text.length;
  const end = match ? match.index + match[0].length : text.length;
  const value = text.slice(contentStart, contentEnd);
  return {
    type: 'string',
    start,
    end,
    value,
    quote: nowdoc ? "<<<'" : '<<<',
    contentStart,
    contentEnd,
    closed: Boolean(match),
    interpolated: !nowdoc && /\$[A-Za-z_{]|\{\$/.test(value),
  };
}
