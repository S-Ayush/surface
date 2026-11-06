/**
 * The client sync store: owns the pool, the replica storage, the start-up
 * sequence (SPEC-002 §3.1–3.2) and the live connection with delta apply
 * (§3.4, §3.6). The mutation queue and overlay (PLAN-002 S8) plug in here.
 *
 * Once ready, the store connects the socket and applies each `deltas`
 * message to the pool at once, then persists it as one storage write. Storage
 * writes, starts and resyncs run one at a time, in order.
 */
import type { ModelDef } from '@surface/domain/model';
import type { DeltasMessage, ResyncMessage, SyncGroup } from '@surface/sync-protocol';
import {
  ProtocolError,
  SOCKET_PATH,
  computeSchemaHash,
  encodeSocketConnectParams,
} from '@surface/sync-protocol';
import type { IObservableValue } from 'mobx';
import { observable, runInAction } from 'mobx';
import type { BootstrapProgress, FetchLike } from './bootstrap.js';
import { ClientOutdatedError, bootstrap } from './bootstrap.js';
import { planDeltas } from './deltas.js';
import type { HydrateResult } from './hydrate.js';
import { hydrate } from './hydrate.js';
import type { LockMode, ReplicaLocks } from './locks.js';
import { replicaLockName, webLocks } from './locks.js';
import { Persistence } from './persistence.js';
import type { ReadonlyPool } from './pool.js';
import { ObjectPool } from './pool.js';
import type { StorageConnector } from './storage/open.js';
import { openStorage, replicaName } from './storage/open.js';
import type { ConnectionState, OnlineSource, SocketFactory, Timers, Verdict } from './socket.js';
import { SyncSocket, socketUrl, webSocketFactory, windowOnline } from './socket.js';
import { randomUuid } from './uuid.js';

/** `outdated`: the server runs another schema; the page must reload (E7). */
export type SyncStatus = 'idle' | 'hydrating' | 'bootstrapping' | 'ready' | 'failed' | 'outdated';

/** How the live connection is made. Every member has a browser default. */
export interface ConnectionOptions {
  /** Defaults to the browser WebSocket at `baseUrl`. */
  readonly socket?: SocketFactory;
  readonly timers?: Timers;
  /** For backoff jitter; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Defaults to the window `online` event. */
  readonly online?: OnlineSource;
}

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
  readonly connection?: ConnectionOptions;
  /**
   * This tab's client id (E5). Defaults to a fresh UUID.
   * TODO(PLAN-002 S8): persist it with the pending queue, so resends dedupe (E4).
   */
  readonly clientId?: string;
  /** Close code 4001: the session was revoked; send the user to login (E10). */
  readonly onSessionRevoked?: () => void;
}

/** Rejected deliveries of one message before the store re-bootstraps instead. */
const REJECTED_MESSAGE_LIMIT = 3;

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
  readonly #socket: SyncSocket;
  /** A resync failed; it runs again as soon as the server is reachable. */
  #resyncPending = false;
  /** How the running store started; `undefined` until started and after `close`. */
  #started: 'warm' | 'cold' | undefined;
  /** The same message rejected on reconnect after reconnect, at one position. */
  #rejected: { at: number; count: number } | undefined;
  readonly #error = observable.box<string | undefined>(undefined);
  readonly clientId: string;

  constructor(options: SyncStoreOptions) {
    this.#options = options;
    this.#pool = new ObjectPool(options.models);
    this.schemaHash = computeSchemaHash(options.models);
    this.#replica = replicaName(options.workspaceId, options.userId);
    this.#locks = options.locks ?? webLocks();
    this.clientId = options.clientId ?? randomUuid();
    const connection = options.connection ?? {};
    const online = connection.online ?? windowOnline();
    this.#socket = new SyncSocket({
      url: () =>
        socketUrl(
          options.baseUrl ?? '',
          SOCKET_PATH,
          encodeSocketConnectParams({
            since: this.#position.get()?.lastSyncId ?? 0,
            clientId: this.clientId,
            schemaHash: this.schemaHash,
          }),
        ),
      factory: connection.socket ?? webSocketFactory,
      onMessage: (message) => this.#receive(message),
      onRevoked: () => options.onSessionRevoked?.(),
      onOpen: () => {
        if (this.#resyncPending) this.#resyncFromServer();
      },
      ...(connection.timers ? { timers: connection.timers } : {}),
      ...(connection.random ? { random: connection.random } : {}),
      ...(online ? { online } : {}),
    });
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

  /** Why the last start or resync failed, for the inspector (SPEC-002 §5.4). Observable. */
  get error(): string | undefined {
    return this.#error.get();
  }

  /** The live connection, for the offline indicator. Observable. */
  get connection(): ConnectionState {
    return this.#socket.state;
  }

  /**
   * Open the replica, then warm start from it or bootstrap from the server.
   * Resolves once the pool is usable; the live connection then opens with
   * `since = lastSyncId` (SPEC-002 §3.1 step 3, §3.2 step 3).
   */
  start(): Promise<'warm' | 'cold'> {
    return this.#serially(async (signal) => {
      // Already running: hydrating again would roll the pool back behind deltas
      // whose writes are still queued.
      if (this.#started !== undefined && this.status === 'ready') return this.#started;
      const result = await this.#start(signal);
      // Closed while finishing (e.g. as the replica lock was released): stay down.
      signal.throwIfAborted();
      this.#started = result;
      this.#socket.start();
      return result;
    });
  }

  /**
   * Re-bootstrap (E7, E8), then reconnect from the new position. Overlays and
   * pending mutations are kept. No deltas apply while it runs: a connection
   * from before would carry deltas older than the new snapshot. If it fails,
   * the connection retries with backoff and the resync runs again once the
   * server is reachable.
   */
  resync(): Promise<void> {
    this.#socket.stop();
    return this.#serially(async (signal) => {
      // A start queued before this resync may have connected in between.
      this.#socket.stop();
      this.#resyncPending = false;
      try {
        const persistence = await this.#openPersistence(signal);
        await this.#locked(persistence, 'exclusive', signal, () =>
          this.#bootstrap(persistence, signal),
        );
      } catch (error) {
        // Bad data (a row the client rejects) comes back the same on a retry:
        // fail and stay down until a reload, like a failed first start.
        const retry =
          !signal.aborted &&
          !(error instanceof ClientOutdatedError) &&
          !(error instanceof ProtocolError);
        if (retry) {
          this.#resyncPending = true;
          this.#socket.retryLater();
        }
        throw error;
      }
      signal.throwIfAborted();
      this.#socket.start();
    });
  }

  /**
   * Stop any start or resync in progress, wait for it to settle, close
   * storage, and return to `idle`. The pool keeps its rows until the next
   * `start` replaces them. `start` may be called again.
   */
  close(): Promise<void> {
    this.#socket.stop();
    this.#resyncPending = false;
    this.#abort.abort();
    this.#abort = new AbortController();
    // Queued, so the running task settles first and a later `start` runs after.
    const run = this.#queue.then(async () => {
      this.#socket.stop(); // in case the task that just settled connected anyway
      this.#started = undefined;
      this.#rejected = undefined;
      const persistence = this.#persistence.get();
      runInAction(() => {
        this.#error.set(undefined);
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

  /** Run `task` after everything queued before it; a failure sets the status. */
  #serially<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.#abort.signal;
    return this.#enqueue(async () => {
      try {
        return await task(signal);
      } catch (error) {
        const status = signal.aborted
          ? 'idle'
          : error instanceof ClientOutdatedError
            ? 'outdated'
            : 'failed';
        runInAction(() => {
          this.#status.set(status);
          if (status === 'failed') {
            this.#error.set(error instanceof Error ? error.message : String(error));
          }
        });
        throw error;
      }
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** A server message for the replica (SPEC-002 §3.4, E1, E2, E7, E8). */
  #receive(message: DeltasMessage | ResyncMessage): Verdict {
    if (message.t === 'resync') {
      if (message.reason === 'schema') {
        this.#setStatus('outdated');
        return 'pause';
      }
      this.#resyncFromServer();
      return 'pause';
    }
    // Deltas belong on top of a finished snapshot; while a start or resync
    // runs (or after one failed) they would mix two points in time.
    if (this.status !== 'ready') return 'pause';
    const position = this.#position.get();
    if (position === undefined) return 'pause'; // `ready` always has one; this narrows.
    let plan;
    try {
      plan = planDeltas(this.#pool, message, position.lastSyncId);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // A row that does not match its model: drop the connection and retry.
      // Catch-up resends the same message, so after a few tries start over
      // from a snapshot; a snapshot with the same row fails the resync.
      const { lastSyncId } = position;
      const count = this.#rejected?.at === lastSyncId ? this.#rejected.count + 1 : 1;
      this.#rejected = { at: lastSyncId, count };
      if (count < REJECTED_MESSAGE_LIMIT) return 'reconnect';
      this.#rejected = undefined;
      this.#resyncFromServer();
      return 'pause';
    }
    // TODO(PLAN-002 S8): confirm `message.ack` against the pending queue.
    switch (plan.kind) {
      case 'gap':
        return 'reconnect';
      case 'resync':
        // A `G` packet: sync groups changed. Until M7, start over.
        this.#resyncFromServer();
        return 'pause';
      case 'none':
        return 'ok';
      case 'apply': {
        this.#rejected = undefined;
        this.#pool.applyBase(plan.base);
        runInAction(() => this.#position.set({ ...position, lastSyncId: plan.lastSyncId }));
        const persistence = this.#persistence.get();
        const { generation } = position;
        if (persistence && generation !== undefined) {
          void this.#enqueue(() =>
            persistence.writeReplica(generation, (storage) =>
              storage.applyChanges(generation, plan.stored, plan.lastSyncId),
            ),
          );
        }
        return 'ok';
      }
    }
  }

  #resyncFromServer(): void {
    // `resync` reports its own failure through status and retries; nothing to add.
    this.resync().catch(() => undefined);
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
      this.#error.set(undefined);
      this.#position.set(position);
      this.#progress.set(undefined);
      this.#status.set('ready');
    });
  }

  #setStatus(status: SyncStatus): void {
    runInAction(() => this.#status.set(status));
  }
}
