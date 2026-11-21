/**
 * PhpStorm metadata (`.phpstorm.meta.php`, as laravel-ide-helper writes it): the class a call
 * returns for a string argument, e.g. `app('cache')` or a project's own container helper:
 *
 *   override(\app(0), map(['events' => \Illuminate\Events\Dispatcher::class]));
 *   override(\Illuminate\Contracts\Container\Container::make(0), map([...]));
 *
 * Only `map([...])` overrides of the first argument are read; `type(0)` and `elementType(0)`
 * (the argument itself is the class) are left to the class-string handling.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Lower-cased function (`app`, `container::make`) → string argument → candidate classes. */
export type MetaMaps = Map<string, Map<string, string[]>>;

const OVERRIDE = /override\(\s*\\?([\w\\]+(?:::\w+)?)\(\s*0\s*\)\s*,\s*map\(\s*\[([\s\S]*?)\]\s*\)\s*\)/g;
const ENTRY = /(['"])((?:\\.|(?!\1).)*)\1\s*=>\s*(?:\\?([\w\\]+)::class|(['"])\\?([\w\\]+)\4)/g;

export function parseMeta(text: string, into: MetaMaps = new Map()): MetaMaps {
  for (const override of text.matchAll(OVERRIDE)) {
    const fn = override[1].toLowerCase();
    let map = into.get(fn);
    if (!map) {
      map = new Map();
      into.set(fn, map);
    }
    for (const entry of override[2].matchAll(ENTRY)) {
      const key = entry[2];
      const cls = entry[3] ?? entry[5];
      if (!key || !cls) {
        continue;
      }
      const list = map.get(key) ?? [];
      if (!list.includes(cls)) {
        list.push(cls);
      }
      map.set(key, list);
    }
  }
  return into;
}

/** The PHP files of the configured paths (files as given, directories one level deep). */
export function metaFiles(root: string, paths: string[]): string[] {
  const files: string[] = [];
  for (const entry of paths) {
    const full = path.resolve(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      files.push(full);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) {
        if (name.endsWith('.php')) {
          files.push(path.join(full, name));
        }
      }
    }
  }
  return files;
}
