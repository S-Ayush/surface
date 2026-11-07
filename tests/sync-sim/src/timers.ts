import type { Timers } from '@surface/sync-client';

type Handle = ReturnType<typeof setTimeout>;

/**
 * One tab's timers, on the simulation's (fake) global clock. A crash kills
 * them: a closed tab's socket, queue retries and lease renewals stop at once,
 * which is what lets another tab adopt its queue (SPEC-002 E5).
 */
export class TabTimers implements Timers {
  readonly #handles = new Set<Handle>();
  #dead = false;

  setTimeout(callback: () => void, ms: number): Handle | undefined {
    if (this.#dead) return undefined;
    const handle = setTimeout(() => {
      this.#handles.delete(handle);
      if (!this.#dead) callback();
    }, ms);
    this.#handles.add(handle);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    for (const own of this.#handles) {
      if (own !== handle) continue;
      clearTimeout(own);
      this.#handles.delete(own);
      return;
    }
  }

  kill(): void {
    this.#dead = true;
    for (const handle of this.#handles) clearTimeout(handle);
    this.#handles.clear();
  }
}
