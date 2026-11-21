/**
 * How often completions of columns and tables are picked, per project: a frecency score (each
 * pick decays with a half-life) ranks the items, and comparing today's ranking with the one of a
 * week ago tells which items rise (▲) and which fall (▼). Stored as JSON in the project's cache
 * directory, written a moment after a change.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Entry {
  /** All picks ever. */
  count: number;
  /** The most recent picks (ms since epoch), oldest first. */
  picks: number[];
}

export type Trend = 'up' | 'down' | 'steady';

const MAX_PICKS = 24;
const DAY = 86_400_000;
const TREND_WINDOW = 7 * DAY;
const RANKING_TTL = 30_000;

export class UsageStore {
  private entries = new Map<string, Entry>();
  private readonly file: string | undefined;
  private halfLife: number;
  private writeTimer: NodeJS.Timeout | undefined;
  private ranking: { at: number; now: Map<string, number>; before: Map<string, number> } | undefined;
  private readonly log: (message: string) => void;

  constructor(file: string | undefined, halfLifeDays: number, log: (message: string) => void = () => undefined) {
    this.file = file;
    this.halfLife = halfLifeDays * DAY;
    this.log = log;
    this.load();
  }

  setHalfLife(days: number): void {
    this.halfLife = days * DAY;
    this.ranking = undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  count(key: string): number {
    return this.entries.get(key)?.count ?? 0;
  }

  record(key: string, now = Date.now()): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { count: 0, picks: [] };
      this.entries.set(key, entry);
    }
    entry.count++;
    entry.picks.push(now);
    if (entry.picks.length > MAX_PICKS) {
      entry.picks.splice(0, entry.picks.length - MAX_PICKS);
    }
    this.changed();
  }

  /** Forgets one key, every key starting with `prefix*`, or everything. */
  reset(key?: string): number {
    let removed = 0;
    if (key === undefined) {
      removed = this.entries.size;
      this.entries.clear();
    } else if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      for (const k of [...this.entries.keys()]) {
        if (k.startsWith(prefix)) {
          this.entries.delete(k);
          removed++;
        }
      }
    } else if (this.entries.delete(key)) {
      removed = 1;
    }
    if (removed) {
      this.changed();
    }
    return removed;
  }

  /** Frecency at `now`: every pick counts 1, halved per half-life of age. */
  score(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry ? this.scoreOf(entry, now) : 0;
  }

  private scoreOf(entry: Entry, now: number): number {
    let score = 0;
    for (const pick of entry.picks) {
      if (pick <= now) {
        score += 0.5 ** ((now - pick) / this.halfLife);
      }
    }
    // Picks older than the kept ones: as old as the oldest kept pick.
    const older = entry.count - entry.picks.length;
    if (older > 0 && entry.picks.length > 0 && entry.picks[0] <= now) {
      score += older * 0.5 ** ((now - entry.picks[0]) / this.halfLife);
    }
    return score;
  }

  /** 1-based position in the current ranking; undefined when never picked. */
  rank(key: string, now = Date.now()): number | undefined {
    return this.rankings(now).now.get(key);
  }

  /** Rank movement compared with a week ago. */
  trend(key: string, now = Date.now()): Trend | undefined {
    const { now: current, before } = this.rankings(now);
    const rank = current.get(key);
    if (rank === undefined) {
      return undefined;
    }
    const previous = before.get(key);
    if (previous === undefined || rank < previous) {
      return 'up';
    }
    if (rank > previous) {
      return 'down';
    }
    const entry = this.entries.get(key);
    // Same place, but nothing picked lately: it is fading.
    if (entry && entry.picks.length > 0 && now - entry.picks[entry.picks.length - 1] > TREND_WINDOW) {
      return 'down';
    }
    return 'steady';
  }

  private rankings(now: number): { now: Map<string, number>; before: Map<string, number> } {
    if (this.ranking && now - this.ranking.at < RANKING_TTL && now >= this.ranking.at) {
      return this.ranking;
    }
    const rankAt = (at: number) => {
      const scored: Array<[string, number]> = [];
      for (const [key, entry] of this.entries) {
        const score = this.scoreOf(entry, at);
        if (score > 0) {
          scored.push([key, score]);
        }
      }
      scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return new Map(scored.map(([key], i) => [key, i + 1]));
    };
    this.ranking = { at: now, now: rankAt(now), before: rankAt(now - TREND_WINDOW) };
    return this.ranking;
  }

  /** Keys by score, best first. */
  top(limit: number, prefix = '', now = Date.now()): Array<{ key: string; score: number; count: number }> {
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, score: this.scoreOf(entry, now), count: entry.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private changed(): void {
    this.ranking = undefined;
    if (!this.file || this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => this.flush(), 1500);
    this.writeTimer.unref();
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (!this.file) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }));
      fs.renameSync(temp, this.file);
    } catch (error) {
      this.log(`laravel-query: cannot write usage statistics: ${String(error)}`);
    }
  }

  private load(): void {
    if (!this.file) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: Record<string, Entry> };
      for (const [key, entry] of Object.entries(data.entries ?? {})) {
        if (typeof entry?.count === 'number' && Array.isArray(entry.picks)) {
          this.entries.set(key, { count: entry.count, picks: entry.picks.filter((p) => typeof p === 'number') });
        }
      }
    } catch {
      // No statistics yet.
    }
  }
}

/** Usage keys: one namespace for columns, one for tables, scoped by connection. */
export function columnKey(connection: string, namespace: string, table: string, column: string): string {
  return `c:${connection}:${namespace}.${table}.${column}`.toLowerCase();
}

export function tableKey(connection: string, namespace: string, table: string): string {
  return `t:${connection}:${namespace}.${table}`.toLowerCase();
}

/** `users.name` from a column key, for messages. */
export function describeKey(key: string): string {
  const match = /^[ct]:[^:]*:(?:[^.]*\.)?(.*)$/.exec(key);
  return match ? match[1] : key;
}
