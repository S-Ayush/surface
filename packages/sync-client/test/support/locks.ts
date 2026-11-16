import type { LockMode, ReplicaLocks } from '../../src/locks.js';

interface Held {
  readonly name: string;
  readonly mode: LockMode;
  readonly tab: string;
}

interface Waiting {
  readonly name: string;
  readonly mode: LockMode;
  readonly tab: string;
  readonly run: () => void;
}

const aborted = () => new DOMException('The request was aborted.', 'AbortError');

/**
 * Web Locks shared by the tabs of one browser profile (SPEC-002 E5): shared locks together,
 * exclusive ones alone, granted in request order; `ifAvailable` answers `null` at once when the
 * lock is taken. Enough for the team locks of PLAN-011 S4c (`surface-team:<id>`).
 */
export class FakeLocks {
  readonly held: Held[] = [];
  readonly #waiting: Waiting[] = [];
  readonly #dead = new Set<string>();

  /** The `navigator.locks` of tab `tab`. */
  forTab(tab: string): ReplicaLocks {
    return {
      request: (name, options, callback) => this.#request(tab, name, options, callback),
    };
  }

  /**
   * The tab died: the browser drops its waiting requests and frees every lock it held (their
   * callbacks never settle).
   */
  kill(tab: string): void {
    // Its code may still run on (a promise that never settles stops it only where awaited):
    // nothing more is granted to it.
    this.#dead.add(tab);
    for (let i = this.#waiting.length - 1; i >= 0; i -= 1) {
      if (this.#waiting[i]?.tab === tab) this.#waiting.splice(i, 1);
    }
    for (const held of this.held.filter((h) => h.tab === tab)) this.#release(held);
  }

  /** Who holds `name`, and how. */
  holders(name: string): { tab: string; mode: LockMode }[] {
    return this.held.filter((h) => h.name === name).map(({ tab, mode }) => ({ tab, mode }));
  }

  /** How many requests for `name` wait. */
  waiting(name: string): number {
    return this.#waiting.filter((w) => w.name === name).length;
  }

  #request<T>(
    tab: string,
    name: string,
    options: { mode: LockMode; signal?: AbortSignal; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    if (this.#dead.has(tab)) return new Promise<T>(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        const held: Held = { name, mode: options.mode, tab };
        this.held.push(held);
        callback({ name, mode: options.mode }).then(
          (value) => {
            this.#release(held);
            resolve(value);
          },
          (error: unknown) => {
            this.#release(held);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      };
      if (options.signal?.aborted === true) {
        reject(aborted());
        return;
      }
      const free =
        this.#grantable(name, options.mode) && !this.#waiting.some((w) => w.name === name);
      if (free) run();
      else if (options.ifAvailable) callback(null).then(resolve, reject);
      else {
        const waiting: Waiting = { name, mode: options.mode, tab, run };
        this.#waiting.push(waiting);
        // As Web Locks: aborting a request still waiting rejects it with an AbortError.
        options.signal?.addEventListener('abort', () => {
          const at = this.#waiting.indexOf(waiting);
          if (at < 0) return;
          this.#waiting.splice(at, 1);
          reject(aborted());
        });
      }
    });
  }

  #grantable(name: string, mode: LockMode): boolean {
    const holders = this.held.filter((h) => h.name === name);
    return holders.length === 0 || (mode === 'shared' && holders.every((h) => h.mode === 'shared'));
  }

  #release(held: Held): void {
    const at = this.held.indexOf(held);
    if (at >= 0) this.held.splice(at, 1);
    for (let i = 0; i < this.#waiting.length;) {
      const next = this.#waiting[i];
      if (next === undefined) break;
      // Request order per name: a waiting request blocks later ones on the same name.
      const earlier = this.#waiting.slice(0, i).some((w) => w.name === next.name);
      if (!earlier && this.#grantable(next.name, next.mode)) {
        this.#waiting.splice(i, 1);
        next.run();
      } else i += 1;
    }
  }
}
