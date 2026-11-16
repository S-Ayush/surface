/**
 * When content is prefetched (SPEC-011 §5.4; PLAN-011 S7): the rows a list shows, once they have
 * stayed 200 ms; an issue the pointer rests on, after 150 ms. `content.ts` decides what is
 * fetched (issues held and followed, not hydrated yet) and how (50 per request, 4 in flight).
 */
import type { Timers } from './socket.js';

/** A list prefetches its first 50 visible rows (§5.4). */
export const PREFETCH_LIST_ROWS = 50;
/** …once they have stayed 200 ms, so scrolling past rows fetches nothing. */
export const PREFETCH_LIST_DEBOUNCE_MS = 200;
/** An issue under the pointer for 150 ms is prefetched (§5.4). */
export const PREFETCH_HOVER_MS = 150;
/** After start, the open issues assigned to the user: the 100 most recently updated (§5.4). */
export const PREFETCH_ASSIGNED = 100;

export class PrefetchScheduler {
  readonly #timers: Timers;
  readonly #prefetch: (issueIds: readonly string[]) => void;
  /** The pending list prefetch of each slot (one per list view). */
  readonly #lists = new Map<string, unknown>();

  constructor(timers: Timers, prefetch: (issueIds: readonly string[]) => void) {
    this.#timers = timers;
    this.#prefetch = prefetch;
  }

  /**
   * A view (`slot`) shows these issues, in order: once they stay for `PREFETCH_LIST_DEBOUNCE_MS`
   * the first `limit` are prefetched. A later call for the same slot replaces a pending one; an
   * empty list cancels it.
   */
  list(slot: string, issueIds: readonly string[], limit = PREFETCH_LIST_ROWS): void {
    this.#cancel(slot);
    const wanted = issueIds.slice(0, limit);
    if (wanted.length === 0) return;
    const timer = this.#timers.setTimeout(() => {
      if (this.#lists.get(slot) !== timer) return;
      this.#lists.delete(slot);
      this.#prefetch(wanted);
    }, PREFETCH_LIST_DEBOUNCE_MS);
    this.#lists.set(slot, timer);
  }

  /** The pointer rests on an issue: prefetched after `PREFETCH_HOVER_MS`, unless cancelled first. */
  hover(issueId: string): () => void {
    let pending = true;
    const timer = this.#timers.setTimeout(() => {
      if (!pending) return;
      pending = false;
      this.#prefetch([issueId]);
    }, PREFETCH_HOVER_MS);
    return () => {
      if (!pending) return;
      pending = false;
      this.#timers.clearTimeout(timer);
    };
  }

  /** The store closed: nothing pending fires. */
  close(): void {
    for (const slot of [...this.#lists.keys()]) this.#cancel(slot);
  }

  #cancel(slot: string): void {
    const timer = this.#lists.get(slot);
    if (timer === undefined) return;
    this.#lists.delete(slot);
    this.#timers.clearTimeout(timer);
  }
}
