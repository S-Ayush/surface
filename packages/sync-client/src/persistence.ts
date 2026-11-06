/**
 * Wraps the storage so a storage failure never breaks the app (SPEC-002 E6).
 * The pool is the source of truth for rendering; storage speeds up the next
 * start and holds the pending-mutation queue (PLAN-002 S8).
 *
 * Two kinds of failure are kept apart:
 * - **Fenced** (E5): another tab re-bootstrapped the shared replica. Only this
 *   tab's generation of rows ends; the other tab persists the same data, so
 *   storage stays usable (pending mutations included) and nothing is shown.
 * - **Lost**: anything else (quota, IndexedDB closed, worker gone). This tab
 *   stops writing and shows a warning.
 *
 * The in-memory fallback is written to like any storage; it just never
 * counts as persistent.
 */
import type { IObservableValue } from 'mobx';
import { observable, runInAction } from 'mobx';
import type { SyncStorage } from './storage/types.js';
import { QueueFencedError, StorageFencedError } from './storage/types.js';

export const MEMORY_FALLBACK_WARNING =
  'Offline storage is unavailable, so changes are lost if you close this tab.';

export class Persistence {
  readonly #lost: IObservableValue<string | undefined> = observable.box(undefined);
  readonly #fallback: string | undefined;
  readonly #fenced = new Set<string>();

  constructor(
    readonly storage: SyncStorage,
    fallbackReason: string | undefined,
  ) {
    this.#fallback =
      storage.kind === 'memory' ? (fallbackReason ?? MEMORY_FALLBACK_WARNING) : undefined;
  }

  /** False when data does not survive a reload. Observable. */
  get persistent(): boolean {
    return this.storage.kind === 'indexeddb' && this.#lost.get() === undefined;
  }

  /** Why data won't survive a reload, for the warning banner. Observable. */
  get warning(): string | undefined {
    return this.#lost.get() ?? this.#fallback;
  }

  /** Whether rows can still be written under `generation`. */
  isCurrent(generation: string): boolean {
    return this.#lost.get() === undefined && !this.#fenced.has(generation);
  }

  /** Run a storage operation. Returns `undefined` instead of throwing once storage is lost. */
  async write<T>(operation: (storage: SyncStorage) => Promise<T>): Promise<T | undefined> {
    if (this.#lost.get() !== undefined) return undefined;
    try {
      return await operation(this.storage);
    } catch (error) {
      this.lose(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** Like `write`, for writes under a replica generation, which another tab may fence. */
  async writeReplica<T>(
    generation: string,
    operation: (storage: SyncStorage) => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.isCurrent(generation)) return undefined;
    try {
      return await operation(this.storage);
    } catch (error) {
      if (error instanceof StorageFencedError) this.#fenced.add(generation);
      else this.lose(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /**
   * Like `write`, for the mutation queue. `QueueFencedError` is rethrown: the
   * queue must stop, but storage itself is fine.
   */
  async writeQueue<T>(operation: (storage: SyncStorage) => Promise<T>): Promise<T | undefined> {
    if (this.#lost.get() !== undefined) return undefined;
    try {
      return await operation(this.storage);
    } catch (error) {
      if (error instanceof QueueFencedError) throw error;
      this.lose(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  lose(reason: string): void {
    runInAction(() => {
      if (this.#lost.get() === undefined) this.#lost.set(reason);
    });
  }
}
