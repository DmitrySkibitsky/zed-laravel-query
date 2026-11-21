#!/usr/bin/env node
// One version for the extension and its server, kept in five files:
// extension.toml, Cargo.toml, Cargo.lock, server/package.json, server/package-lock.json.
// The extension downloads the server from the GitHub release `v<version>`, so they must agree.
//
//   node scripts/version.mjs check [vX.Y.Z]   all files agree (and match the tag, if given)
//   node scripts/version.mjs set X.Y.Z        write the version everywhere
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = 'zed_laravel_query';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Each source: read the version, or write a new one. TOML is edited by line, not re-serialised. */
const sources = {
  'extension.toml': {
    read: (text) => /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
    write: (text, v) => text.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
  'Cargo.toml': {
    // the [package] section's version (the first `version =` line)
    read: (text) => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(text)?.[1],
    write: (text, v) => text.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/ms, `$1${v}$2`),
  },
  'Cargo.lock': {
    read: (text) => new RegExp(`^name = "${CRATE}"\\nversion = "([^"]+)"`, 'm').exec(text)?.[1],
    write: (text, v) => text.replace(new RegExp(`^(name = "${CRATE}"\\nversion = ")[^"]+(")`, 'm'), `$1${v}$2`),
  },
  'server/package.json': {
    read: (text) => JSON.parse(text).version,
    write: (text, v) => `${JSON.stringify({ ...JSON.parse(text), version: v }, null, 2)}\n`,
  },
  'server/package-lock.json': {
    read: (text) => {
      const lock = JSON.parse(text);
      return lock.version === lock.packages?.['']?.version
        ? lock.version
        : `${lock.version} / ${lock.packages?.['']?.version}`;
    },
    write: (text, v) => {
      const lock = JSON.parse(text);
      lock.version = v;
      lock.packages[''].version = v;
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
};

function versions() {
  return Object.entries(sources).map(([file, source]) => ({
    file,
    version: source.read(fs.readFileSync(path.join(ROOT, file), 'utf8')),
  }));
}

function check(tag) {
  const found = versions();
  const expected = tag ? tag.replace(/^v/, '') : found[0].version;
  if (tag && !/^v/.test(tag)) {
    fail(`release tags look like v${expected}, got ${tag}`);
  }
  const wrong = found.filter((f) => f.version !== expected);
  if (wrong.length || !SEMVER.test(expected ?? '')) {
    for (const f of found) {
      console.error(`${f.version === expected ? ' ' : '✗'} ${f.file}: ${f.version}`);
    }
    fail(tag ? `versions do not match the tag ${tag}` : 'versions differ: run `make version VERSION=x.y.z`');
  }
  console.log(`version ${expected}${tag ? ` matches ${tag}` : ''} in ${found.length} files`);
}

function set(version) {
  if (!SEMVER.test(version ?? '')) {
    fail(`not a version: ${version} (expected X.Y.Z)`);
  }
  for (const [file, source] of Object.entries(sources)) {
    const full = path.join(ROOT, file);
    const text = fs.readFileSync(full, 'utf8');
    const next = source.write(text, version);
    if (source.read(next) !== version) {
      fail(`could not set the version in ${file}`);
    }
    fs.writeFileSync(full, next);
  }
  check();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, argument] = process.argv.slice(2);
if (command === 'check') {
  check(argument);
} else if (command === 'set') {
  set(argument);
} else {
  fail('usage: version.mjs check [vX.Y.Z] | set X.Y.Z');
}
