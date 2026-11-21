import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { siteOf } from '../src/analysis/chain.ts';
import { bladeToPhp } from '../src/php/blade.ts';
import { literalValue, PhpDocument } from '../src/php/document.ts';
import { isStringToken, tokenize } from '../src/php/lexer.ts';

describe('lexer', () => {
  test('tokenizes names, variables, operators and strings', () => {
    const tokens = tokenize(`<?php \\App\\Models\\User::query()?->where('a\\'b', "x\\n$y");`);
    assert.deepEqual(
      tokens.map((t) => t.value),
      ['\\App\\Models\\User', '::', 'query', '(', ')', '?->', 'where', '(', "a'b", ',', 'x\n$y', ')', ';'],
    );
    const double = tokens[10];
    assert.ok(isStringToken(double) && double.interpolated);
    const single = tokens[8];
    assert.ok(isStringToken(single) && !single.interpolated && single.closed);
  });

  test('skips inline HTML, comments; keeps doc comments apart', () => {
    const tokens = tokenize(
      `<h1>'not php'</h1><?php // 'comment'\n# 'hash'\n/* 'block' */ /** @var User $u */ $u; ?>tail'`,
    );
    assert.deepEqual(
      tokens.map((t) => `${t.type}:${t.value}`),
      ['doc:/** @var User $u */', 'var:$u', 'op:;', 'op:;'],
    );
  });

  test('attributes are not comments', () => {
    const tokens = tokenize(`<?php #[Table('users')] class A {}`);
    assert.equal(tokens[0].value, '#[');
    assert.equal(literalValue(tokens[3]), 'users');
  });

  test('heredoc and nowdoc', () => {
    const text = `<?php $a = <<<SQL\n  select * from {$t}\n  SQL;\n$b = <<<'X'\nraw $v\nX;\n$c = 1;`;
    const strings = tokenize(text).filter(isStringToken);
    assert.equal(strings.length, 2);
    assert.equal(strings[0].quote, '<<<');
    assert.ok(strings[0].interpolated);
    assert.equal(strings[1].quote, "<<<'");
    assert.equal(strings[1].value, 'raw $v');
    assert.ok(tokenize(text).some((t) => t.value === '$c'));
  });

  test('unterminated string runs to the end without throwing', () => {
    const tokens = tokenize(`<?php $q->where('na`);
    const last = tokens[tokens.length - 1];
    assert.ok(isStringToken(last) && !last.closed && last.value === 'na');
  });
});

describe('document', () => {
  const source = `<?php
namespace App\\Http;

use App\\Models\\{User, Post as Article};
use Illuminate\\Support\\Facades\\DB;

class Controller extends Base
{
    use SomeTrait;

    public function index(Builder $query, ?User $user = null)
    {
        $fn = function ($q) use ($user) { return $q; };
        $arrow = fn (JoinClause $join) => $join->on('a', '=', 'b');
    }
}

function helper() {}
`;
  const doc = new PhpDocument(source);

  test('namespace, grouped and aliased imports', () => {
    assert.equal(doc.namespace, 'App\\Http');
    assert.equal(doc.resolveClass('User'), 'App\\Models\\User');
    assert.equal(doc.resolveClass('Article'), 'App\\Models\\Post');
    assert.equal(doc.resolveClass('DB'), 'Illuminate\\Support\\Facades\\DB');
    assert.equal(doc.resolveClass('Other'), 'App\\Http\\Other');
    assert.equal(doc.resolveClass('\\Root'), 'Root');
    assert.ok(!doc.uses.has('sometrait'), 'trait use is not an import');
  });

  test('classes and functions with parameters', () => {
    assert.equal(doc.classes[0].fqn, 'App\\Http\\Controller');
    assert.equal(doc.classes[0].extends, 'App\\Http\\Base');
    const kinds = doc.functions.map((f) => `${f.kind}:${f.name ?? ''}`);
    assert.deepEqual(kinds, ['method:index', 'closure:', 'arrow:', 'function:helper']);
    assert.deepEqual(
      doc.functions[0].params.map((p) => `${p.type} ${p.name}`),
      ['Builder $query', '?User $user'],
    );
    assert.deepEqual(doc.functions[1].useVars, ['$user']);
    const arrow = doc.functions[2];
    assert.equal(doc.tokens[arrow.bodyEnd].value, ')');
  });

  test('call sites of strings: argument index, arrays, keys and values', () => {
    const d = new PhpDocument(`<?php $q->where(['a' => 'v', 'b'])->select('x', ['y', 'z']);`);
    const at = (value: string) => d.tokens.findIndex((t) => t.type === 'string' && t.value === value);
    const site = (value: string) => {
      const s = siteOf(d, at(value));
      assert.ok(s && s.type === 'call');
      return s;
    };
    assert.equal(site('a').arrays[0].isKey, true);
    assert.equal(site('v').arrays[0].isValue, true);
    assert.equal(site('b').arrays[0].elementIndex, 1);
    assert.equal(site('x').name, 'select');
    assert.equal(site('x').argIndex, 0);
    assert.equal(site('z').argIndex, 1);
    assert.equal(site('z').arrays.length, 1);
  });

  test('index access is not an array argument', () => {
    const d = new PhpDocument(`<?php $q->where($row['col'], 1);`);
    const index = d.tokens.findIndex((t) => t.value === 'col');
    assert.equal(siteOf(d, index), undefined);
  });

  test('property arrays and return arrays', () => {
    const d = new PhpDocument(
      `<?php class U { protected $fillable = ['name']; public function casts(): array { return ['at' => 'date']; } }`,
    );
    const fillable = siteOf(
      d,
      d.tokens.findIndex((t) => t.value === 'name'),
    );
    assert.equal(fillable?.type, 'property');
    const casts = siteOf(
      d,
      d.tokens.findIndex((t) => t.value === 'at'),
    );
    assert.equal(casts?.type, 'return');
  });
});

describe('blade', () => {
  test('keeps PHP regions at the same offsets', () => {
    const source = `<div class="it's">{{ DB::table('users')->value('name') }}</div>\n@if ($user->posts()->where('title', 'x')->exists())\n@php $q = User::query(); @endphp\n{{-- {{ hidden('x') }} --}}`;
    const php = bladeToPhp(source);
    assert.equal(php.length, source.length);
    assert.equal(php.split('\n').length, source.split('\n').length);
    assert.equal(php.indexOf("DB::table('users')"), source.indexOf("DB::table('users')"));
    assert.ok(php.includes("$user->posts()->where('title', 'x')"));
    assert.ok(php.includes('$q = User::query();'));
    assert.ok(!php.includes('hidden'));
    assert.ok(!php.includes("it's"));
  });
});
