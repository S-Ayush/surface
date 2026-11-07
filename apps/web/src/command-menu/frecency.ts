// Frecency for ranking (SPEC-005 §4.2, Q2): how often and how recently each command was run,
// kept per user in localStorage. A convenience only: losing it changes the order, nothing else.
import { z } from 'zod';

export const FRECENCY_KEY_PREFIX = 'surface.commandFrecency.';
const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_ENTRIES = 200;

const STORED = z.record(z.string(), z.object({ count: z.number(), last: z.number() }));
type Entry = z.infer<typeof STORED>[string];
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export class Frecency {
  readonly #storage: StorageLike | null;
  readonly #key: string;
  readonly #now: () => number;
  #entries: Record<string, Entry> = {};

  constructor(options: { storage: StorageLike | null; userId: string | null; now?: () => number }) {
    this.#storage = options.storage;
    this.#key = FRECENCY_KEY_PREFIX + (options.userId ?? 'anonymous');
    this.#now = options.now ?? Date.now;
    this.#entries = this.#read();
  }

  #read(): Record<string, Entry> {
    try {
      const raw = this.#storage?.getItem(this.#key);
      if (!raw) return {};
      // Validated like any outside data: another version or a hand edit may have changed it.
      const parsed = STORED.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  /** ≥ 1: 1 for a command never run; grows with use and fades with a 14-day half-life. */
  boost(id: string): number {
    const entry = this.#entries[id];
    if (entry === undefined) return 1;
    const ageDays = Math.max(0, this.#now() - entry.last) / DAY_MS;
    const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS);
    return 1 + Math.log2(1 + entry.count) * 0.25 * recency;
  }

  record(id: string): void {
    const entry = this.#entries[id];
    this.#entries[id] = { count: (entry?.count ?? 0) + 1, last: this.#now() };
    const ids = Object.keys(this.#entries);
    if (ids.length > MAX_ENTRIES) {
      const oldest = ids.sort(
        (a, b) => (this.#entries[a]?.last ?? 0) - (this.#entries[b]?.last ?? 0),
      );
      for (const old of oldest.slice(0, ids.length - MAX_ENTRIES)) delete this.#entries[old];
    }
    try {
      // Last writer wins: two open tabs overwrite each other's counts. Acceptable for a ranking
      // hint (SPEC-005 §4.2 "a convenience only").
      this.#storage?.setItem(this.#key, JSON.stringify(this.#entries));
    } catch {
      // Quota or privacy errors: ranking just forgets.
    }
  }
}
