/**
 * The client sync store: owns the pool, the replica storage, and the start-up
 * sequence (SPEC-002 §3.1–3.2). The socket (PLAN-002 S7) and the mutation
 * queue and overlay (S8) plug in here.
 */
import type { ModelDef } from '@surface/domain/model';
import type { SyncGroup } from '@surface/sync-protocol';
import { computeSchemaHash } from '@surface/sync-protocol';
import type { IObservableValue } from 'mobx';
import { observable, runInAction } from 'mobx';
import type { BootstrapProgress, FetchLike } from './bootstrap.js';
import { bootstrap } from './bootstrap.js';
import type { HydrateResult } from './hydrate.js';
import { hydrate } from './hydrate.js';
import type { LockMode, ReplicaLocks } from './locks.js';
import { replicaLockName, webLocks } from './locks.js';
import { Persistence } from './persistence.js';
import type { ReadonlyPool } from './pool.js';
import { ObjectPool } from './pool.js';
import type { StorageConnector } from './storage/open.js';
import { openStorage, replicaName } from './storage/open.js';

export type SyncStatus = 'idle' | 'hydrating' | 'bootstrapping' | 'ready' | 'failed';

export interface SyncStoreOptions {
  readonly models: readonly ModelDef[];
  readonly workspaceId: string;
  readonly userId: string;
  readonly fetch: FetchLike;
  /** Server origin and base path; `''` (default) for same-origin. */
  readonly baseUrl?: string;
  /** How to open the replica; defaults to IndexedDB in a worker with a memory fallback. */
  readonly connectStorage?: StorageConnector;
  /** Cross-tab locks; defaults to `navigator.locks` where available (see `locks.ts`). */
  readonly locks?: ReplicaLocks;
  readonly chunkSize?: number;
}

/** Where the replica position stands after a start or resync. */
export interface ReplicaPosition {
  readonly lastSyncId: number;
  readonly groups: readonly SyncGroup[];
  /** The generation deltas are written to (PLAN-002 S7); `undefined` if storage failed. */
  readonly generation: string | undefined;
}

export class SyncStore {
  readonly #pool: ObjectPool;
  readonly schemaHash: string;
  readonly #options: SyncStoreOptions;
  readonly #replica: string;
  readonly #locks: ReplicaLocks | undefined;
  readonly #status: IObservableValue<SyncStatus> = observable.box('idle');
  readonly #progress: IObservableValue<BootstrapProgress | undefined> = observable.box(undefined, {
    deep: false,
  });
  readonly #position: IObservableValue<ReplicaPosition | undefined> = observable.box(undefined, {
    deep: false,
  });
  readonly #persistence: IObservableValue<Persistence | undefined> = observable.box(undefined, {
    deep: false,
  });
  /** `start` and `resync` run one at a time, in call order. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Aborted by `close`, which stops whatever is running. */
  #abort = new AbortController();

  constructor(options: SyncStoreOptions) {
    this.#options = options;
    this.#pool = new ObjectPool(options.models);
    this.schemaHash = computeSchemaHash(options.models);
    this.#replica = replicaName(options.workspaceId, options.userId);
    this.#locks = options.locks ?? webLocks();
  }

  /** The replica, for views to read (ADR-0015). Reactive. */
  get pool(): ReadonlyPool {
    return this.#pool;
  }

  /** Observable. */
  get status(): SyncStatus {
    return this.#status.get();
  }

  /** Cold-start progress (rows / total), for the progress bar. Observable. */
  get progress(): BootstrapProgress | undefined {
    return this.#progress.get();
  }

  /** Observable. */
  get position(): ReplicaPosition | undefined {
    return this.#position.get();
  }

  /** False when changes won't survive a reload (E6). Observable. */
  get persistent(): boolean {
    return this.#persistence.get()?.persistent ?? false;
  }

  /** Why the replica isn't saved offline, for the warning banner. Observable. */
  get storageWarning(): string | undefined {
    return this.#persistence.get()?.warning;
  }

  /**
   * Open the replica, then warm start from it or bootstrap from the server.
   * Resolves once the pool is usable.
   */
  start(): Promise<'warm' | 'cold'> {
    return this.#serially((signal) => this.#start(signal));
  }

  /** Re-bootstrap after `resync` (E7, E8). Pending mutations are kept. */
  resync(): Promise<void> {
    return this.#serially(async (signal) => {
      const persistence = await this.#openPersistence(signal);
      await this.#locked(persistence, 'exclusive', signal, () =>
        this.#bootstrap(persistence, signal),
      );
    });
  }

  /**
   * Stop any start or resync in progress, wait for it to settle, close
   * storage, and return to `idle`. The pool keeps its rows until the next
   * `start` replaces them. `start` may be called again.
   */
  close(): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    // Queued, so the running task settles first and a later `start` runs after.
    const run = this.#queue.then(async () => {
      const persistence = this.#persistence.get();
      runInAction(() => {
        this.#persistence.set(undefined);
        this.#position.set(undefined);
        this.#progress.set(undefined);
        this.#status.set('idle');
      });
      await persistence?.storage.close();
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #start(signal: AbortSignal): Promise<'warm' | 'cold'> {
    const persistence = await this.#openPersistence(signal);
    this.#setStatus('hydrating');
    const warm =
      (await this.#locked(persistence, 'shared', signal, () => this.#hydrate(persistence))) ??
      (await this.#locked(persistence, 'exclusive', signal, async () => {
        // Another tab may have bootstrapped while this one waited for the lock.
        const stored = await this.#hydrate(persistence);
        if (stored) return stored;
        // Nothing usable stored (missing, unfinished, or another schema): start clean.
        await persistence.write((storage) => storage.clear());
        await this.#bootstrap(persistence, signal);
        return undefined;
      }));
    if (warm === undefined) return 'cold';
    // Closed while the last read was in flight: never report ready after close.
    signal.throwIfAborted();
    // TODO(PLAN-002 S8): re-apply the overlay from persisted pending mutations here.
    const { lastSyncId, groups, generation } = warm.meta;
    this.#ready({
      lastSyncId,
      groups,
      generation: persistence.isCurrent(generation) ? generation : undefined,
    });
    return 'warm';
  }

  #hydrate(persistence: Persistence): Promise<HydrateResult | undefined> {
    return hydrate(this.#pool, persistence, this.schemaHash);
  }

  #serially<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.#abort.signal;
    const run = this.#queue.then(async () => {
      try {
        return await task(signal);
      } catch (error) {
        this.#setStatus(signal.aborted ? 'idle' : 'failed');
        throw error;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Run `task` holding the replica lock (E5). The memory fallback is never shared. */
  #locked<T>(
    persistence: Persistence,
    mode: LockMode,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.#locks === undefined || persistence.storage.kind === 'memory') return task();
    return this.#locks.request(replicaLockName(this.#replica), { mode, signal }, task);
  }

  async #openPersistence(signal: AbortSignal): Promise<Persistence> {
    const current = this.#persistence.get();
    if (current) return current;
    const names = this.#options.models.map((model) => model.name);
    const { storage, fallbackReason } = await openStorage(
      this.#replica,
      names,
      this.#options.connectStorage,
    );
    if (signal.aborted) {
      await storage.close();
      signal.throwIfAborted();
    }
    const persistence = new Persistence(storage, fallbackReason);
    runInAction(() => this.#persistence.set(persistence));
    return persistence;
  }

  async #bootstrap(persistence: Persistence, signal: AbortSignal): Promise<void> {
    this.#setStatus('bootstrapping');
    const result = await bootstrap({
      fetch: this.#options.fetch,
      baseUrl: this.#options.baseUrl ?? '',
      schemaHash: this.schemaHash,
      pool: this.#pool,
      persistence,
      signal,
      ...(this.#options.chunkSize === undefined ? {} : { chunkSize: this.#options.chunkSize }),
      onProgress: (progress) => {
        runInAction(() => this.#progress.set(progress));
      },
    });
    signal.throwIfAborted();
    this.#ready({
      lastSyncId: result.lastSyncId,
      groups: result.groups,
      generation: result.generation,
    });
  }

  #ready(position: ReplicaPosition): void {
    runInAction(() => {
      this.#position.set(position);
      this.#progress.set(undefined);
      this.#status.set('ready');
    });
  }

  #setStatus(status: SyncStatus): void {
    runInAction(() => this.#status.set(status));
  }
}
