import type { Timers } from '../../src/socket.js';

/**
 * Timers that fire only when a test advances them, so connection tests need
 * no real sleeps and no global fake timers (fake-indexeddb schedules with the
 * real ones).
 */
export class ManualTimers implements Timers {
  #now = 0;
  #nextId = 1;
  readonly #pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, { at: this.#now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#pending.delete(handle);
  }

  get now(): number {
    return this.#now;
  }

  /** Delays from now of the timers still pending, soonest first. */
  get pending(): number[] {
    return [...this.#pending.values()].map(({ at }) => at - this.#now).sort((a, b) => a - b);
  }

  /** Run every timer due within `ms`, in time order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const next = this.#earliest();
      if (next === undefined || next[1].at > end) break;
      this.#pending.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
    }
    this.#now = end;
  }

  /** Run the soonest timer and return its delay, or `undefined` if none is pending. */
  runNext(): number | undefined {
    const next = this.#earliest();
    if (next === undefined) return undefined;
    const delay = next[1].at - this.#now;
    this.advance(delay);
    return delay;
  }

  #earliest(): [number, { at: number; callback: () => void }] | undefined {
    let best: [number, { at: number; callback: () => void }] | undefined;
    for (const entry of this.#pending)
      if (best === undefined || entry[1].at < best[1].at) best = entry;
    return best;
  }
}
