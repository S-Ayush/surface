import type { LockMode, ReplicaLocks } from '@surface/sync-client';

/**
 * Web Locks for one simulated browser profile: the tabs of one user share
 * them (SPEC-002 E5). Requests for a name are granted in FIFO order, shared
 * locks together and exclusive ones alone, as the Web Locks spec says. When a
 * tab crashes the browser releases what it held and forgets what it asked
 * for; `kill` does the same.
 */
export class BrowserLocks {
  readonly #held: Held[] = [];
  readonly #waiting: Waiting[] = [];
  /** Crashed tabs: they run no more code, so they ask for nothing more. */
  readonly #dead = new Set<string>();

  /** The `navigator.locks` of tab `tab`. */
  forTab(tab: string): ReplicaLocks & { kill(): void } {
    return {
      request: (name, options, callback) => this.#request(tab, name, options, callback),
      kill: () => this.#kill(tab),
    };
  }

  /** Locks currently held, for tests. */
  get held(): readonly { readonly name: string; readonly mode: LockMode; readonly tab: string }[] {
    return this.#held;
  }

  #request<T>(
    tab: string,
    name: string,
    options: { mode: LockMode; signal?: AbortSignal; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A crashed tab's leftover work never gets a lock (a real one never asks).
      if (this.#dead.has(tab)) return;
      const run = () => {
        const held: Held = { name, mode: options.mode, tab };
        this.#held.push(held);
        // The lock lasts until the callback's promise settles.
        const release = () => this.#release(held);
        callback({ name, mode: options.mode }).then(
          (value) => {
            release();
            resolve(value);
          },
          (error: unknown) => {
            release();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      };
      if (options.signal?.aborted) {
        reject(new DOMException('The lock request was aborted.', 'AbortError'));
        return;
      }
      const free = this.#grantable(name, options.mode) && !this.#queued(name);
      if (options.ifAvailable) {
        if (free) run();
        else callback(null).then(resolve, reject);
        return;
      }
      if (free) {
        run();
        return;
      }
      const waiting: Waiting = { name, mode: options.mode, tab, run };
      this.#waiting.push(waiting);
      options.signal?.addEventListener('abort', () => {
        const index = this.#waiting.indexOf(waiting);
        if (index === -1) return;
        this.#waiting.splice(index, 1);
        reject(new DOMException('The lock request was aborted.', 'AbortError'));
      });
    });
  }

  #grantable(name: string, mode: LockMode): boolean {
    const others = this.#held.filter((held) => held.name === name);
    return mode === 'exclusive'
      ? others.length === 0
      : others.every((held) => held.mode === 'shared');
  }

  #queued(name: string): boolean {
    return this.#waiting.some((waiting) => waiting.name === name);
  }

  #release(held: Held): void {
    const index = this.#held.indexOf(held);
    if (index === -1) return; // Already released by a crash.
    this.#held.splice(index, 1);
    this.#grantWaiting();
  }

  /** Grant queued requests, per name in FIFO order, until one has to wait. */
  #grantWaiting(): void {
    const blocked = new Set<string>();
    for (const waiting of [...this.#waiting]) {
      if (blocked.has(waiting.name)) continue;
      if (!this.#grantable(waiting.name, waiting.mode)) {
        blocked.add(waiting.name);
        continue;
      }
      this.#waiting.splice(this.#waiting.indexOf(waiting), 1);
      waiting.run();
    }
  }

  #kill(tab: string): void {
    this.#dead.add(tab);
    for (let i = this.#waiting.length - 1; i >= 0; i -= 1) {
      if (this.#waiting[i]?.tab === tab) this.#waiting.splice(i, 1);
    }
    for (let i = this.#held.length - 1; i >= 0; i -= 1) {
      if (this.#held[i]?.tab === tab) this.#held.splice(i, 1);
    }
    this.#grantWaiting();
  }
}

interface Held {
  readonly name: string;
  readonly mode: LockMode;
  readonly tab: string;
}

interface Waiting extends Held {
  readonly run: () => void;
}
