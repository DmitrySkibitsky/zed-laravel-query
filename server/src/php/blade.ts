/**
 * Turns a Blade template into PHP code of the same length: the PHP parts (`{{ }}`, `{!! !!}`,
 * `@php … @endphp`, `<?php ?>`, directive arguments) stay where they are, everything else (HTML,
 * Blade comments, delimiters) becomes spaces. Each masked gap starts with `;` so the PHP fragments
 * read as separate statements. Offsets and line breaks are unchanged.
 */

const DIRECTIVE_RE = /@([A-Za-z_]\w*)/y;

export function bladeToPhp(source: string): string {
  const n = source.length;
  const keep: Array<[number, number]> = [];
  let i = 0;

  const closeOrEnd = (from: number, close: string): [number, number] => {
    const at = source.indexOf(close, from);
    return at < 0 ? [n, n] : [at, at + close.length];
  };

  while (i < n) {
    const c = source[i];
    if (c === '{' && source.startsWith('{{--', i)) {
      const [, end] = closeOrEnd(i + 4, '--}}');
      i = end;
      continue;
    }
    if (c === '{' && source.startsWith('{!!', i)) {
      const [contentEnd, end] = closeOrEnd(i + 3, '!!}');
      keep.push([i + 3, contentEnd]);
      i = end;
      continue;
    }
    if (c === '{' && source[i + 1] === '{') {
      const [contentEnd, end] = closeOrEnd(i + 2, '}}');
      keep.push([i + 2, contentEnd]);
      i = end;
      continue;
    }
    if (c === '<' && source[i + 1] === '?' && (source.startsWith('php', i + 2) || source[i + 2] === '=')) {
      const start = i + (source[i + 2] === '=' ? 3 : 5);
      const [contentEnd, end] = closeOrEnd(start, '?>');
      keep.push([start, contentEnd]);
      i = end;
      continue;
    }
    if (c === '@') {
      if (source[i + 1] === '@') {
        i += 2;
        continue;
      }
      if (source[i + 1] === '{' && source[i + 2] === '{') {
        const [, end] = closeOrEnd(i + 3, '}}');
        i = end;
        continue;
      }
      const prev = i > 0 ? source[i - 1] : '';
      DIRECTIVE_RE.lastIndex = i;
      const match = /[\w.]/.test(prev) ? null : DIRECTIVE_RE.exec(source);
      if (match) {
        const name = match[1];
        let j = i + match[0].length;
        while (source[j] === ' ' || source[j] === '\t') {
          j++;
        }
        if (name === 'php' && source[j] !== '(') {
          const [contentEnd, end] = closeOrEnd(i + 4, '@endphp');
          keep.push([i + 4, contentEnd]);
          i = end;
          continue;
        }
        if (name === 'verbatim') {
          const [, end] = closeOrEnd(j, '@endverbatim');
          i = end;
          continue;
        }
        if (source[j] === '(') {
          const close = matchParen(source, j);
          const end = close < 0 ? lineEnd(source, j) : close;
          keep.push([j, end]);
          i = end;
          continue;
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  const out: string[] = [];
  let last = 0;
  for (const [start, end] of keep) {
    out.push(maskGap(source, last, start), source.slice(start, end));
    last = end;
  }
  out.push(maskGap(source, last, n));
  return out.join('');
}

function maskGap(source: string, start: number, end: number): string {
  if (end <= start) {
    return '';
  }
  const masked = source.slice(start, end).replace(/[^\r\n]/g, ' ');
  const first = masked.search(/ /);
  if (first < 0) {
    return masked;
  }
  return `${masked.slice(0, first)};${masked.slice(first + 1)}`;
}

function lineEnd(source: string, from: number): number {
  const eol = source.indexOf('\n', from);
  return eol < 0 ? source.length : eol;
}

/** Index after the `)` matching the `(` at `open`, skipping PHP strings; -1 when unbalanced. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          i++;
        }
        i++;
      }
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}
