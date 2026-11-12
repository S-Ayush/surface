/**
 * The client sync store: owns the pool, the replica storage, the start-up
 * sequence (SPEC-002 §3.1–3.2), the live connection with delta apply (§3.4,
 * §3.6), and local mutations: `dispatch`, the queue and the overlay (§3.3,
 * §3.5, PLAN-002 S8).
 *
 * Once ready, the store connects the socket and applies each `deltas`
 * message to the pool at once, then persists it as one storage write. Storage
 * writes, starts and resyncs run one at a time, in order. Each message also
 * confirms the mutations it covers, and the overlay is rebuilt in the same
 * MobX batch, so a view never sees a change twice or not at all.
 */
import type { ClientRefResolver } from '@surface/domain';
import type { ModelDef } from '@surface/domain/model';
import type { AnyOperation, InputOf, OperationRegistry } from '@surface/operations';
import { registry as defaultRegistry } from '@surface/operations';
import type { DeltasMessage, ResyncMessage, SyncGroup } from '@surface/sync-protocol';
import {
  ProtocolError,
  SESSION_PATH,
  SOCKET_PATH,
  computeSchemaHash,
  encodeSocketConnectParams,
} from '@surface/sync-protocol';
import type { IObservableValue } from 'mobx';
import { observable, reaction, runInAction } from 'mobx';
import type { BootstrapProgress, FetchLike } from './bootstrap.js';
import { ClientOutdatedError, bootstrap } from './bootstrap.js';
import type { AppliedPacket } from './deltas.js';
import { planDeltas } from './deltas.js';
import type { HydrateResult } from './hydrate.js';
import { hydrate } from './hydrate.js';
import type { LockMode, ReplicaLocks } from './locks.js';
import { replicaLockName, webLocks } from './locks.js';
import { OverlayEngine } from './overlay.js';
import type { QueueOwnership } from './owner.js';
import { claimQueue } from './owner.js';
import { Persistence } from './persistence.js';
import type { ReadonlyPool } from './pool.js';
import { ObjectPool } from './pool.js';
import type { MutationOutcome, PendingView, Rejection } from './queue.js';
import { MutationQueue } from './queue.js';
import { createClientRefResolver, poolRefSource } from './refs.js';
import type { StorageConnector } from './storage/open.js';
import { openStorage, replicaName } from './storage/open.js';
import { QueueFencedError } from './storage/types.js';
import type { ConnectionState, OnlineSource, SocketFactory, Timers, Verdict } from './socket.js';
import { SyncSocket, globalTimers, socketUrl, webSocketFactory, windowOnline } from './socket.js';
import { browserCsrfToken } from './csrf.js';
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
  /**
   * Cross-tab locks; defaults to `navigator.locks` where available (see
   * `locks.ts`). `null`: none, as on a plain-HTTP origin.
   */
  readonly locks?: ReplicaLocks | null;
  readonly chunkSize?: number;
  readonly connection?: ConnectionOptions;
  /**
   * The client id of this store's first new mutation queue (E5); defaults to a
   * fresh UUID. For tests: it must never have been used before, or the server
   * takes seq 1 for a resend. Later starts (after `close`) always use a fresh
   * id, and a start that adopts a queue left by a closed tab keeps that id.
   */
  readonly clientId?: string;
  /** Close code 4001: the session was revoked; send the user to login (E10). */
  readonly onSessionRevoked?: () => void;
  /**
   * The CSRF token sent with each mutate request (SPEC-001 §6.1); read again
   * for every request. Defaults to the page's `surface_csrf` cookie.
   */
  readonly csrfToken?: () => string | undefined;
  /** Operations that pending mutations name; defaults to every operation. */
  readonly operations?: OperationRegistry;
  /** The server rejected a mutation; its effect is gone (SPEC-002 §3.5): show a toast. */
  readonly onRejected?: (rejection: Rejection) => void;
  /** The server runs a newer schema (`CLIENT_OUTDATED`): show the reload banner (E7). */
  readonly onOutdated?: () => void;
  /** Epoch ms, for mutation timestamps and queue leases; defaults to `Date.now`. */
  readonly clock?: () => number;
}

/** How long the "is the server up?" probe waits for an answer (sync-protocol.md §4.3). */
const PROBE_TIMEOUT_MS = 10_000;

/** Rejections kept for the inspector (SPEC-002 §5.4). */
const RECENT_REJECTIONS = 20;
/** Applied packets kept for the inspector (SPEC-002 §5.4). */
export const RECENT_PACKETS = 50;

/** An applied delta packet, for the inspector: what changed, not the row (SPEC-002 §5.4). */
export interface PacketView extends AppliedPacket {
  /** Epoch ms when it was applied. */
  readonly appliedAt: number;
}

/** This tab's most recent confirmed mutation and how long it took (SPEC-002 §5.4 server lag). */
export interface RoundTrip {
  readonly op: string;
  readonly seq: number;
  readonly ms: number;
}
/** Another tab took over this tab's queue while it had work in it. */
const QUEUE_LOST = new QueueFencedError().message;

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
  readonly #overlay: OverlayEngine;
  readonly #refs: ClientRefResolver;
  /** The queue this tab owns; set by a start, cleared by `close`. */
  readonly #mutations: IObservableValue<MutationQueue | undefined> = observable.box(undefined, {
    deep: false,
  });
  readonly #rejections = observable.array<Rejection>([], { deep: false });
  /** Newest first. */
  readonly #packets = observable.array<PacketView>([], { deep: false });
  readonly #roundTrip = observable.box<RoundTrip | undefined>(undefined, { deep: false });
  /**
   * The id a new queue gets if no queue is adopted. Never reused once a start
   * may have sent under it: a new queue starts at seq 1, and the server would
   * answer a reused `(clientId, seq)` with the old result (review B1).
   */
  #freshClientId: string;
  /** This tab's queue-owner token (see `owner.ts`). */
  readonly #tab = randomUuid();
  /** Another tab took this tab's queue (with work in it) over: failed until a new start. */
  #lost = false;

  constructor(options: SyncStoreOptions) {
    this.#options = options;
    this.#pool = new ObjectPool(options.models);
    this.schemaHash = computeSchemaHash(options.models);
    this.#replica = replicaName(options.workspaceId, options.userId);
    this.#locks = options.locks === null ? undefined : (options.locks ?? webLocks());
    this.#freshClientId = options.clientId ?? randomUuid();
    this.#refs = createClientRefResolver(poolRefSource(this.#pool), () => options.userId);
    this.#overlay = new OverlayEngine(this.#pool, () => options.userId);
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
            userId: this.#options.userId,
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
      ...(options.clock ? { clock: options.clock } : {}),
      probe: () => this.#serverAnswers(),
    });
    // SPEC-002 §3.6: queue while offline; send once connected on a usable replica.
    reaction(
      () => this.connection === 'online' && this.status === 'ready' && this.#mutations.get(),
      (queue) => {
        if (queue) queue.setOnline(true);
      },
    );
    reaction(
      () => this.connection === 'online',
      (online) => {
        if (!online) this.#mutations.get()?.setOnline(false);
      },
    );
  }

  /**
   * The id this tab sends mutations and connects under: its queue's, once a
   * start has claimed one (an adopted queue keeps its id). Observable.
   */
  get clientId(): string {
    return this.#mutations.get()?.clientId ?? this.#freshClientId;
  }

  /** Resolves references (`ENG`, `me`, a status name) against the replica (SPEC-003 §4). */
  get refs(): ClientRefResolver {
    return this.#refs;
  }

  /** Mutations not yet confirmed, in seq order, for the offline badge and inspector. Observable. */
  get pending(): readonly PendingView[] {
    return this.#mutations.get()?.pending ?? [];
  }

  /** The most recent rejections, newest last, for the inspector. Observable. */
  get rejections(): readonly Rejection[] {
    return this.#rejections;
  }

  /**
   * Run a mutation locally and queue it for the server (SPEC-002 §3.3). The
   * input is validated first (`InvalidInputError`, nothing queued); then its
   * `optimistic()` effect shows before this returns. The promise settles when
   * the server's change reaches the replica (`confirmed`) or the server
   * rejects it (`rejected`, effect rolled back). It stays pending if the store
   * closes first: the mutation stays queued and the next start sends it.
   */
  dispatch<Op extends AnyOperation>(op: Op, input: InputOf<Op>): Promise<MutationOutcome> {
    const queue = this.#mutations.get();
    if (this.status === 'outdated') {
      throw new Error('Surface was updated. Reload the page to keep working.');
    }
    if (this.#lost) throw new Error(QUEUE_LOST);
    if (queue === undefined || queue.stopped) {
      throw new Error(
        'Changes cannot be saved yet. Wait for the workspace to load, then try again.',
      );
    }
    return queue.dispatch(op, input);
  }

  /** The models this store syncs, by name (for the inspector's row counts). */
  get modelNames(): readonly string[] {
    return this.#options.models.map((model) => model.name);
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

  /** Epoch ms when `connection` last changed. Observable. */
  get connectionSince(): number {
    return this.#socket.since;
  }

  /**
   * Epoch ms since the connection has been trying to get back online;
   * `undefined` while online or stopped ("Reconnecting > 5 s"). Observable.
   */
  get reconnectingSince(): number | undefined {
    return this.#socket.reconnectingSince;
  }

  /**
   * The server answers plain HTTP but connection attempts keep failing
   * before they open, as when a proxy refuses WebSocket upgrades (SPEC-005
   * §8, sync-protocol.md §4.3). Observable.
   */
  get liveUpdatesUnavailable(): boolean {
    return this.#socket.liveUpdatesUnavailable;
  }

  /** The last applied delta packets, newest first, for the inspector. Observable. */
  get recentPackets(): readonly PacketView[] {
    return this.#packets;
  }

  /** This tab's latest confirmed mutation and its round trip, for the inspector. Observable. */
  get lastRoundTrip(): RoundTrip | undefined {
    return this.#roundTrip.get();
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
    this.#mutations.get()?.setOnline(false);
    this.#abort.abort();
    this.#abort = new AbortController();
    // Queued, so the running task settles first and a later `start` runs after.
    const run = this.#queue.then(async () => {
      this.#socket.stop(); // in case the task that just settled connected anyway
      this.#started = undefined;
      this.#rejected = undefined;
      this.#lost = false;
      // Queued mutations stay in storage; the next start (or another tab) sends them.
      await this.#mutations.get()?.stop();
      const persistence = this.#persistence.get();
      runInAction(() => {
        this.#mutations.set(undefined);
        this.#overlay.rebuild([]);
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
    await this.#claimQueue(persistence, signal);
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
    const { lastSyncId, groups, generation } = warm.meta;
    this.#ready({
      lastSyncId,
      groups,
      generation: persistence.isCurrent(generation) ? generation : undefined,
    });
    return 'warm';
  }

  get #timers(): Timers {
    return this.#options.connection?.timers ?? globalTimers;
  }

  /** Adopt a queue left by a closed tab, or start one (SPEC-002 E5, `owner.ts`). */
  async #claimQueue(persistence: Persistence, signal: AbortSignal): Promise<void> {
    // A stopped queue (taken over) is replaced: a new start is like a reload.
    if (this.#mutations.get()?.stopped === false) return;
    const ownership = await claimQueue({
      persistence,
      replica: this.#replica,
      locks: this.#locks,
      fresh: this.#freshClientId,
      owner: this.#tab,
      clock: this.#options.clock ?? Date.now,
      timers: this.#timers,
      onLost: () => this.#queueLost(persistence),
      isIdle: () => this.#mutations.get()?.pending.length === 0,
      onAdopt: (adopted) => this.#adopt(adopted, persistence),
    });
    // A fresh id is used up once a queue has it: the next new queue needs another (review B1).
    if (ownership.clientId === this.#freshClientId) this.#freshClientId = randomUuid();
    const queue = this.#newQueue(ownership, persistence);
    runInAction(() => {
      this.#lost = false;
      this.#mutations.set(queue);
    });
    if (signal.aborted) {
      // `close` already ran its task or is about to; make sure the claim is let go.
      await queue.stop();
      runInAction(() => this.#mutations.set(undefined));
      signal.throwIfAborted();
    }
  }

  #newQueue(ownership: QueueOwnership, persistence: Persistence): MutationQueue {
    const queue: MutationQueue = new MutationQueue(ownership, persistence, {
      fetch: this.#options.fetch,
      baseUrl: this.#options.baseUrl ?? '',
      userId: this.#options.userId,
      schemaHash: this.schemaHash,
      registry: this.#options.operations ?? defaultRegistry,
      csrfToken: this.#options.csrfToken ?? browserCsrfToken,
      timers: this.#timers,
      random: this.#options.connection?.random ?? Math.random,
      clock: this.#options.clock ?? Date.now,
      replicaAt: () => (this.status === 'ready' ? this.#position.get()?.lastSyncId : undefined),
      onPush: (mutation) => this.#overlay.push(mutation),
      onRebuild: () => this.#overlay.rebuild(queue.mutations),
      onRejected: (rejection) => {
        runInAction(() => {
          this.#rejections.push(rejection);
          if (this.#rejections.length > RECENT_REJECTIONS) this.#rejections.shift();
        });
        try {
          this.#options.onRejected?.(rejection);
        } catch {
          // The app's handler (a toast) must not break sync; it reports its own bugs.
        }
      },
      onOutdated: () => this.#outdated(),
      onUnauthenticated: () => this.#redial(),
      onFenced: () => this.#queueLost(persistence),
      onConfirmed: ({ op, seq, sentAt }) => {
        const ms = Math.max(0, (this.#options.clock ?? Date.now)() - sentAt);
        runInAction(() => this.#roundTrip.set({ op, seq, ms }));
      },
    });
    return queue;
  }

  /**
   * Lease mode: switch to a queue left with work by a tab that is gone, if
   * this tab's own queue is still empty and the replica is usable.
   */
  #adopt(ownership: QueueOwnership, persistence: Persistence): boolean {
    const current = this.#mutations.get();
    const position = this.#position.get();
    if (current === undefined || current.stopped || current.pending.length > 0) return false;
    if (this.status !== 'ready' || position === undefined) return false;
    // Not released: the lease now covers the adopted queue (`owner.ts`).
    void current.stop({ release: false });
    const queue = this.#newQueue(ownership, persistence);
    runInAction(() => {
      this.#mutations.set(queue);
      this.#confirm(position.lastSyncId, [], true);
    });
    this.#redial();
    return true;
  }

  /**
   * Another tab took this tab's queue over, or forgot it (lease mode). With
   * nothing of ours in it, carry on with a new queue; otherwise stop, and say
   * how to recover.
   */
  #queueLost(persistence: Persistence): void {
    const queue = this.#mutations.get();
    if (queue === undefined || queue.stopped) return;
    void queue.stop();
    if (queue.pending.length === 0) {
      runInAction(() => this.#mutations.set(undefined));
      const signal = this.#abort.signal;
      void this.#enqueue(async () => {
        await this.#claimQueue(persistence, signal);
        if (this.status === 'ready') this.#redial();
      }).catch(() => undefined);
      return;
    }
    this.#socket.stop();
    runInAction(() => {
      this.#lost = true;
      this.#status.set('failed');
      this.#error.set(QUEUE_LOST);
    });
  }

  /** Reconnect under the current `clientId`: acks are addressed to the connection's. */
  #redial(): void {
    const state = this.#socket.state;
    if (state === 'disconnected' || state === 'revoked') return;
    this.#socket.stop();
    this.#socket.start();
  }

  /** The server runs a newer build (E7): stop, and ask for a reload once. */
  #outdated(): void {
    this.#socket.stop();
    if (this.status === 'outdated') return;
    this.#setStatus('outdated');
    this.#options.onOutdated?.();
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
        if (!signal.aborted && error instanceof ClientOutdatedError) {
          this.#outdated();
          throw error;
        }
        const status = signal.aborted ? 'idle' : 'failed';
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
        this.#outdated();
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
    switch (plan.kind) {
      case 'gap':
        return 'reconnect';
      case 'resync':
        // A `G` packet: sync groups changed. Until M7, start over.
        this.#resyncFromServer();
        return 'pause';
      case 'none':
        // A repeat, or acks for mutations whose rows this client cannot see.
        runInAction(() => this.#confirm(position.lastSyncId, message.ack, false));
        return 'ok';
      case 'apply': {
        this.#rejected = undefined;
        runInAction(() => {
          this.#pool.applyBase(plan.base);
          this.#position.set({ ...position, lastSyncId: plan.lastSyncId });
          this.#recordPackets(plan.applied);
          const touched = plan.base.some((change) =>
            this.#overlay.dependsOn(
              change.model,
              change.kind === 'upsert' ? change.row.id : change.id,
            ),
          );
          this.#confirm(plan.lastSyncId, message.ack, touched);
        });
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

  /**
   * Drop the mutations the replica now includes (sync-protocol.md §5.2 step 2)
   * and rebuild the overlay if that or the base change can alter it (step 3).
   */
  #confirm(
    lastSyncId: number,
    acks: readonly { clientId: string; seq: number }[],
    baseTouched: boolean,
  ): void {
    const queue = this.#mutations.get();
    if (queue === undefined) return;
    const confirmed = queue.confirm(lastSyncId, acks);
    if (confirmed || baseTouched) this.#overlay.rebuild(queue.mutations);
  }

  #recordPackets(applied: readonly AppliedPacket[]): void {
    const appliedAt = (this.#options.clock ?? Date.now)();
    const views = applied.map((packet): PacketView => ({ ...packet, appliedAt })).reverse();
    this.#packets.unshift(...views);
    if (this.#packets.length > RECENT_PACKETS) this.#packets.length = RECENT_PACKETS;
  }

  /**
   * Whether the server answers plain HTTP: any status below 500 from
   * `GET /auth/session`. A server that is down, starting (`503`) or behind a
   * proxy that cannot reach it (`502`, `504`) does not (sync-protocol.md §4.3).
   */
  async #serverAnswers(): Promise<boolean> {
    const timers = this.#timers;
    const controller = new AbortController();
    const timeout = timers.setTimeout(() => controller.abort('timeout'), PROBE_TIMEOUT_MS);
    try {
      const base = (this.#options.baseUrl ?? '').replace(/\/$/, '');
      const response = await this.#options.fetch(`${base}${SESSION_PATH}`, {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      await response.body?.cancel();
      return response.status < 500;
    } catch {
      return false;
    } finally {
      timers.clearTimeout(timeout);
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
      userId: this.#options.userId,
      schemaHash: this.schemaHash,
      pool: this.#pool,
      persistence,
      signal,
      timers: this.#timers,
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
    // The queue was taken over meanwhile (review m5): stay failed until a new start.
    if (this.#lost) throw new QueueFencedError();
    runInAction(() => {
      this.#error.set(undefined);
      this.#position.set(position);
      // SPEC-002 §3.2 step 2: pending mutations show on top of the new base.
      this.#confirm(position.lastSyncId, [], true);
      this.#progress.set(undefined);
      this.#status.set('ready');
    });
  }

  #setStatus(status: SyncStatus): void {
    runInAction(() => this.#status.set(status));
  }
}
