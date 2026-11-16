/**
 * Content hydration, the client half of per-issue content (SPEC-011 §5.3, §5.4; PLAN-011 S5b).
 * One per store (tab). "Hydration" here is content's; the M0 warm start is `hydrate.ts`.
 *
 * Content models (IssueContent, IssueHistory, Comment, Reaction) are not bootstrapped. A parent
 * (an Issue) is **hydrated** once the replica holds all its content and keeps it live. The
 * hydrated set lives in storage, shared by the replica's tabs (E18); this tab keeps in memory
 * only what it **paged in** (rows in the pool) and what it is loading.
 *
 * - **Open** (`open`, and dispatch's `ensure`): a parent hydrated in storage is paged in from
 *   there; otherwise, online, it is fetched with `GET /sync/content` and stored at the answer's
 *   `C`. Its team must be subscribed first (§5.7): opening subscribes it on demand.
 * - **Loading:** while any load is in flight, the content packets that arrive are remembered
 *   (`#since`); a loading parent's upserts don't reach the pool. When the load lands, each row
 *   takes the newer of the loaded version and the remembered packet (a buffered packet above `C`
 *   wins, E17), and storage gets the buffered upserts again after the answer.
 * - **Answer:** a parent whose Issue the pool no longer holds (purged meanwhile, E23), or whose
 *   team this tab no longer follows, is skipped, and so is any row whose parent isn't in the
 *   answer's `parents` (E15).
 * - **Live:** `deltas.ts` routes packets through `routing`; an Issue `I` hydrates it when its team
 *   is subscribed (step 5), and goes straight into the pool if it is open here.
 * - **Gone:** a batch that leaves a parent absent drops its content and marks (`deltas.ts`, and
 *   storage); an unsubscribe or sweep drops them through `forget` (`subscriptions.ts`).
 * - **Start and resync** clear the paged set (step 7); open parents load again.
 * - **Cache** (§5.4, Q11; PLAN-011 S7): an open parent's content lock is held shared; past
 *   `cacheLimit` hydrated parents, the least recently opened are evicted (rows and mark in one
 *   transaction), skipping any whose lock another tab holds. Without Web Locks on shared storage,
 *   nothing is evicted.
 * - **Prefetch** (§5.4): `prefetch(ids)` stores parents' content without paging it in, at most
 *   50 parents per request and 4 requests in flight; a parent a multi-parent answer left out for
 *   its size budget (D16) is asked for again.
 */
import { isUuid, issueIdentifier, type RefType } from '@surface/domain';
import type { ModelDef, ModelRow } from '@surface/domain/model';
import type { ContentParentRef } from '@surface/operations';
import {
  CONTENT_PATH,
  ContentStreamReader,
  MAX_CONTENT_PARENTS,
  NdjsonDecoder,
  ProtocolError,
  encodeContentQuery,
  issueParent,
  parentIssueId,
} from '@surface/sync-protocol';
import type { IObservableValue, ObservableSet } from 'mobx';
import { observable, reaction, runInAction, untracked, when } from 'mobx';
import type { FetchLike } from './bootstrap.js';
import type { ReplicaLocks } from './locks.js';
import { contentLockName, holdShared, tryHold } from './locks.js';
import type { ModelInstance } from './instance.js';
import { fieldOf, rowOf } from './instance.js';
import { ClientOutdatedError, decodeRow, requestNdjson } from './bootstrap.js';
import type { ContentPacket, ContentRouting, DeltaPlan } from './deltas.js';
import type { PartialRules } from './partial.js';
import type { Persistence } from './persistence.js';
import type { BaseChange, ObjectPool } from './pool.js';
import type { ConnectionState, Timers } from './socket.js';
import { backoffDelay } from './socket.js';
import type { ContentMark, ContentModelRef, ContentWrite, StoredChange } from './storage/types.js';
import { teamOf } from './storage/types.js';
import type { TeamLoadState } from './subscriptions.js';

/**
 * Whether a parent's content can be shown (SPEC-011 §5.3, E11): `ready` once paged in (or there is
 * nothing to load: a parent the server doesn't show), `loading` until then, `offline` when it was
 * never hydrated and can't be fetched now ("Available when online").
 */
export type ContentLoadState = 'loading' | 'ready' | 'offline';

/**
 * A parent's content read once from the server and kept nowhere (`content.peek`, PLAN-012 S4b):
 * `ready` with the rows per content model (none when the server doesn't show the parent), `offline`
 * when the connection is down, `failed` when the request failed while online.
 */
export type ContentPeek =
  | { readonly state: 'ready'; readonly rows: Readonly<Record<string, readonly ModelRow[]>> }
  | { readonly state: 'offline' }
  | { readonly state: 'failed' };

/** An open parent (`content.open`). */
export interface ContentHandle {
  /** Settles once the parent is paged in, or can't be now: its load state then. */
  readonly ready: Promise<ContentLoadState>;
  /** The view closed: the parent's content lock is let go. Repeated calls do nothing. */
  release(): void;
}

/**
 * A content mutation on a parent never hydrated, while offline (SPEC-011 §5.3 step 6): refused,
 * nothing queued. The UI offers no content edit then (SPEC-013 E20).
 */
export class ContentUnavailableError extends Error {
  override readonly name = 'ContentUnavailableError';
  constructor() {
    super('Available when online');
  }
}

/**
 * A content mutation whose parent couldn't be loaded while online (a server or network error):
 * refused, nothing queued. Not "Available when online": the connection is up, so trying again
 * may work (SPEC-011 D14).
 */
export class ContentLoadFailedError extends Error {
  override readonly name = 'ContentLoadFailedError';
  constructor(label: string) {
    super(`Couldn't load ${label}. Try again.`);
  }
}

/** The content models of `models`, with their parents (`defineModel`'s `parent`). */
export function contentModels(models: readonly ModelDef[]): ContentModelRef[] {
  return models.flatMap((def) =>
    def.load === 'content' && def.parent !== undefined
      ? [{ model: def.name, field: String(def.parent.field), parent: def.parent.model }]
      : [],
  );
}

/** At most this many hydrated parents per replica (SPEC-011 §5.4, Q11). */
export const CONTENT_CACHE_LIMIT = 2000;

/** At most this many prefetch requests in flight (SPEC-011 §5.4). */
export const PREFETCH_REQUESTS = 4;

/**
 * At most this many parents wait for a prefetch: the assigned issues (100), a list's rows (50) and
 * a few hovered, several times over. Beyond it the oldest asked go: a list scrolled past since.
 */
export const PREFETCH_QUEUE_LIMIT = 500;

/** What content hydration needs from its store. */
export interface ContentHost {
  readonly pool: ObjectPool;
  /** The replica, for lock names. */
  readonly replica: string;
  /** The most hydrated parents the replica keeps (`CONTENT_CACHE_LIMIT`). */
  readonly cacheLimit: number;
  /** Web Locks for shared storage; `undefined` without them, or for memory storage. */
  locks(): ReplicaLocks | undefined;
  /** Whether storage is shared by tabs (IndexedDB); memory storage is this tab's alone. */
  sharedStorage(): boolean;
  readonly models: readonly ContentModelRef[];
  readonly rules: PartialRules | undefined;
  readonly timers: Timers;
  readonly random: () => number;
  clock(): number;
  /** Observable. */
  connection(): ConnectionState;
  /** Observable: the store is ready (a replica is loaded). */
  ready(): boolean;
  /** Observable: the teams this tab's connection follows. */
  followedTeams(): ReadonlySet<string>;
  openTeam(teamId: string): void;
  whenTeamLoaded(teamId: string): Promise<TeamLoadState>;
  /** The id of the row a reference names (`ENG-42`), or `undefined`. */
  resolveRef(type: RefType, value: string): string | undefined;
  persistence(): Persistence | undefined;
  /** The generation storage writes go to, if any. */
  generation(): string | undefined;
  /** Run a storage task after the ones queued before it (the store's serial queue). */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Server rows into the pool's base; the overlay is rebuilt (§5.4: paging in). */
  applyBase(changes: readonly BaseChange[]): void;
  fetchContent(parents: readonly string[], signal: AbortSignal): Promise<ContentAnswer>;
  outdated(): void;
}

/** How one load ended. `stale`: a start, resync or close overtook it. */
type LoadResult = 'ready' | 'missing' | 'offline' | 'failed' | 'stale';

/**
 * What dispatch does after `ensure`: `unavailable` offline with the parent never hydrated (E11);
 * `failed` when loading it failed while online (D14).
 */
export type EnsureResult = 'proceed' | 'unavailable' | 'failed' | 'closed';

/** A loaded content row, with the version that wrote it. */
interface LoadedRow {
  readonly model: string;
  readonly row: ModelRow;
  readonly archived: boolean;
  readonly version: number;
}

const rowKey = (model: string, id: string) => `${model}\u0000${id}`;

/** The models a reference type resolves (`refs.ts` `REF_MODELS`), for content parents. */
const REF_TYPE_OF_MODEL: ReadonlyMap<string, RefType> = new Map([['Issue', 'IssueRef']]);

export class ContentHydration {
  readonly #host: ContentHost;
  readonly #byModel: ReadonlyMap<string, ContentModelRef>;
  readonly #parentModels: ReadonlySet<string>;
  /** Parents whose content is in the pool (hydrated, and kept live in it). */
  readonly #paged: ObservableSet<string> = observable.set();
  /** Parents being read from storage, or fetched from the server. */
  readonly #loading: ObservableSet<string> = observable.set();
  /** Of `#loading`, those an open is fetching from the server (not paging in from the replica). */
  readonly #fetching: ObservableSet<string> = observable.set();
  /** Parents whose last load couldn't reach the server: a retry's replica check shows no loading. */
  readonly #unavailable: ObservableSet<string> = observable.set();
  /** Parents the server didn't show (unknown, invisible, or not in this replica): nothing to load. */
  readonly #missing: ObservableSet<string> = observable.set();
  /** Of `#missing`, those the pool didn't show: they load once it does. */
  readonly #absent = new Set<string>();
  /** Open handles and waiting dispatches, per parent. */
  readonly #wanted = new Map<string, number>();
  /** Loads in flight, per parent, so two opens share one. */
  readonly #loads = new Map<string, Promise<LoadResult>>();
  /** Content packets since the oldest load in flight began: the last per row (§5.3 step 2). */
  readonly #since = new Map<string, ContentPacket>();
  #inFlight = 0;
  /** Bumped by a start, resync or close: loads of an older epoch land nowhere. */
  readonly #epoch: IObservableValue<number> = observable.box(0);
  readonly #closed: IObservableValue<boolean> = observable.box(false);
  #abort = new AbortController();
  /** Retries of failed loads of open parents, per parent; `timer` is unset between attempts. */
  readonly #retries = new Map<string, { timer: unknown; attempt: number }>();
  #stopOnline: (() => void) | undefined;
  #stopFound: (() => void) | undefined;
  #stopReach: (() => void) | undefined;
  /**
   * Whether content could be fetched when last tried: false from a failed connection attempt
   * until the socket is online again, so a parent never hydrated stays `offline` while the
   * socket keeps retrying (E11), instead of flickering to `loading` with each attempt.
   */
  readonly #reachable: IObservableValue<boolean> = observable.box(true);
  /** The content lock of each wanted parent (§5.4): its release once granted. */
  readonly #holds = new Map<string, Promise<(() => Promise<void>) | undefined>>();
  #lockAbort = new AbortController();
  /**
   * Prefetch (§5.4): parents asked for and not requested yet, in the order asked. Kept until they
   * can be (the store online, the issue held, its team followed), across a resync; at most
   * `PREFETCH_QUEUE_LIMIT`, the oldest dropped first.
   */
  readonly #prefetchQueue: string[] = [];
  /** Bumped when `#prefetchQueue` changes, so the pump's reaction sees it. */
  readonly #prefetchQueued: IObservableValue<number> = observable.box(0);
  #stopPrefetch: (() => void) | undefined;
  /** Parents in a prefetch request in flight, with its end: an open of one waits for it. */
  readonly #prefetching = new Map<string, Promise<void>>();
  #prefetchRequests = 0;
  /** Eviction running, and whether it was asked for again meanwhile. */
  #evicting: Promise<void> | undefined;
  #evictAgain = false;
  readonly routing: ContentRouting;

  constructor(host: ContentHost) {
    this.#host = host;
    this.#byModel = new Map(host.models.map((ref) => [ref.model, ref]));
    this.#parentModels = new Set(host.models.map((ref) => ref.parent));
    this.routing = {
      models: this.#byModel,
      parents: this.#parentModels,
      inPool: (parent) => this.#paged.has(parent),
      hydratesOnInsert: (model, row) => this.#teamAllows(model, row),
      wanted: (parent) => this.#wanted.has(parent),
    };
  }

  /** Whether the store has content models at all. */
  get enabled(): boolean {
    return this.#byModel.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Reads

  /** Observable; see `ContentLoadState`. */
  state(parent: string): ContentLoadState {
    const id = parent.toLowerCase();
    if (this.#paged.has(id) || this.#missing.has(id)) return 'ready';
    if (!this.#host.ready()) return 'loading';
    // Paging in from the replica works offline; a fetch while the socket can't connect shows
    // "Available when online" until it lands (E11), not a loading state with each retry.
    const paging = this.#loading.has(id) && !this.#fetching.has(id);
    if (paging && !this.#unavailable.has(id)) return 'loading';
    return this.#reachableNow() ? 'loading' : 'offline';
  }

  /** The parent's content rows in the pool, per content model, by id. Observable. */
  rows(parent: string): Readonly<Record<string, readonly ModelRow[]>> {
    const id = parent.toLowerCase();
    const out: Record<string, ModelRow[]> = {};
    for (const [model, ref] of this.#byModel) {
      const { pool } = this.#host;
      const fields = Object.keys(pool.model(model).fields);
      const instances = byField(pool, model, ref.field, id);
      // Plain frozen rows, so a view compares them structurally (ADR-0017). Every field is read
      // first, so the caller's reaction sees an edit to any of them.
      out[model] = instances
        .map((instance) => {
          for (const field of fields) fieldOf(instance, field);
          return rowOf(instance);
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return out;
  }

  /** Whether `ref` names a parent paged in now: dispatch need not wait. */
  readyFor(ref: ContentParentRef): boolean {
    const parent = this.#resolve(ref);
    return parent !== undefined && this.#paged.has(parent);
  }

  // ---------------------------------------------------------------------------
  // Open and ensure

  /** Page a parent in, or fetch it; keep it live while the handle is held (§5.4). */
  open(parent: string): ContentHandle {
    const id = parent.toLowerCase();
    this.#want(id);
    let released = false;
    const ready = this.#settle(id).then(() => {
      // Least recently opened goes first (Q11): opening moves the parent up.
      if (!released) this.#touch(id);
      return this.state(id);
    });
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.#unwant(id);
      },
    };
  }

  /**
   * Before a content mutation's `optimistic` runs (SPEC-011 §5.3 step 6): hydrate and page in its
   * parent. `unavailable` when it was never hydrated and can't be fetched now.
   */
  async ensure(ref: ContentParentRef): Promise<EnsureResult> {
    if (this.#closed.get()) return 'closed';
    const parent = this.#resolve(ref);
    if (parent === undefined) {
      // A row the store doesn't hold: a parent never hydrated. Online, the server decides.
      return this.#online() || this.#dialing() ? 'proceed' : 'unavailable';
    }
    if (this.#paged.has(parent)) return 'proceed';
    this.#want(parent);
    try {
      const result = await this.#settle(parent);
      if (this.#closed.get()) return 'closed';
      if (result === 'ready' || result === 'missing') return 'proceed';
      // A load that failed because the connection dropped is E11's case, not D14's.
      return result === 'failed' && this.#reachableNow() ? 'failed' : 'unavailable';
    } finally {
      this.#unwant(parent);
    }
  }

  /**
   * One `GET /sync/content` answer for a parent, returned to the caller and never stored, paged
   * in or marked hydrated (SPEC-012 §3.4 item 8, PLAN-012 S4b): the read-only view of an archived
   * or deleted issue, which the replica doesn't hold. No packet is buffered for it, so the rows
   * are a snapshot; the view asks again to refresh.
   */
  async peek(parent: string): Promise<ContentPeek> {
    const id = parent.toLowerCase();
    if (this.#closed.get()) return { state: 'offline' };
    // A socket about to dial (a start or a resync) waits, as a load does (E11).
    if (!(await this.#fetchable(this.#epoch.get()))) return { state: 'offline' };
    let answer: ContentAnswer;
    try {
      answer = await this.#host.fetchContent([id], this.#abort.signal);
    } catch (error) {
      if (error instanceof ClientOutdatedError) this.#host.outdated();
      // While the socket keeps retrying after a failed attempt, the view says "available when
      // online", as `state()` does, not "couldn't load".
      return this.#reachableNow() ? { state: 'failed' } : { state: 'offline' };
    }
    const rows: Record<string, ModelRow[]> = {};
    for (const model of this.#byModel.keys()) rows[model] = [];
    for (const { model, row } of answer.rows) {
      if (this.#parentOf(model, row)?.toLowerCase() === id) rows[model]?.push(row);
    }
    for (const list of Object.values(rows)) list.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { state: 'ready', rows };
  }

  /** How a refusal names `ref`'s parent: its identifier (`ENG-42`) when the pool shows it. */
  describe(ref: ContentParentRef): string {
    const parent = this.#resolve(ref);
    const rules = this.#host.rules;
    if (parent === undefined || rules === undefined) return 'this issue';
    return untracked(() => {
      const issue = this.#host.pool.get(rules.issue, parent);
      const row = issue === undefined ? undefined : rowOf(issue);
      const teamId = row === undefined ? undefined : teamOf(row);
      const team = teamId === undefined ? undefined : this.#host.pool.get(rules.team, teamId);
      const key = team === undefined ? undefined : rowOf(team)['key'];
      const number = row?.['number'];
      return typeof key === 'string' && typeof number === 'number'
        ? issueIdentifier(key, number)
        : 'this issue';
    });
  }

  // ---------------------------------------------------------------------------
  // Store life cycle

  /** After a start or resync (§5.3 step 7): nothing is paged in; open parents load again. */
  reset(): void {
    this.#newEpoch();
    runInAction(() => {
      this.#closed.set(false);
      // A new replica, so the server answered: no attempt has failed since (E11).
      this.#reachable.set(true);
    });
    this.#stopOnline ??= reaction(
      () => this.#host.ready() && this.#online(),
      (up) => {
        if (up) {
          this.#reloadWanted();
          return;
        }
        // A stalled answer must not hold a waiting dispatch (and the chain behind it) until the
        // body times out: offline, its load ends now, as `offline` (review m4).
        this.#abort.abort();
        this.#abort = new AbortController();
      },
    );
    // A parent missing because its Issue wasn't held yet (its team still loading) loads once the
    // Issue arrives, by a partial answer as well as by a delta.
    this.#stopFound ??= reaction(
      () => [...this.#missing].filter((p) => this.#absent.has(p) && this.#inView(p)),
      (found) => {
        if (found.length === 0) return;
        runInAction(() => {
          for (const parent of found) this.#missing.delete(parent);
        });
        this.#reloadWanted();
      },
    );
    this.#stopReach ??= reaction(
      () => this.#host.connection(),
      (connection) => {
        if (connection === 'online') runInAction(() => this.#reachable.set(true));
        else if (connection === 'offline' || connection === 'revoked') {
          runInAction(() => this.#reachable.set(false));
        }
      },
    );
    // Prefetches asked for before they could run (warm start before the socket is up or the
    // teams acked, a resync, an issue not held yet) run once they can (PLAN-011 S7 review).
    this.#stopPrefetch ??= reaction(
      () => this.#prefetchWaiting(),
      (waiting) => {
        if (waiting > 0) this.#pumpPrefetch();
      },
    );
    void Promise.resolve().then(() => {
      this.#reloadWanted();
      // A replica past the limit (a smaller limit, or marks added while no tab evicted).
      this.#scheduleEviction();
      this.#pumpPrefetch();
    });
  }

  close(): void {
    this.#newEpoch();
    runInAction(() => this.#closed.set(true));
    this.#stopOnline?.();
    this.#stopOnline = undefined;
    this.#stopFound?.();
    this.#stopFound = undefined;
    this.#stopReach?.();
    this.#stopReach = undefined;
    this.#stopPrefetch?.();
    this.#stopPrefetch = undefined;
    this.#setQueue([]);
    // The tab's content locks go with it; a parent still wanted takes its lock again on its next load.
    this.#lockAbort.abort();
    this.#lockAbort = new AbortController();
    for (const parent of [...this.#holds.keys()]) this.#unhold(parent);
  }

  /** An unsubscribe or a sweep removed these issues' content from the pool (§5.7). */
  forget(parents: Iterable<string>): void {
    runInAction(() => {
      for (const parent of parents) {
        this.#paged.delete(parent);
        this.#missing.delete(parent);
        this.#absent.delete(parent);
      }
    });
    // A view still open on one loads it again (subscribing its team), instead of staying empty.
    this.#reloadWanted();
  }

  /** After a delta batch is applied (`deltas.ts` planned it with `routing`). */
  afterDeltas(plan: Extract<DeltaPlan, { kind: 'apply' }>): void {
    runInAction(() => {
      for (const parent of plan.hydrated) {
        this.#missing.delete(parent);
        if (this.#wanted.has(parent)) this.#paged.add(parent);
      }
      for (const parent of plan.goneParents) {
        this.#paged.delete(parent);
        this.#missing.delete(parent);
        // Still open here (deleted or archived, then perhaps restored, PLAN-015 S2): it waits as
        // an issue the pool doesn't show, and loads again once its row comes back.
        if (this.#wanted.has(parent)) {
          this.#absent.add(parent);
          this.#missing.add(parent);
        }
      }
    });
    if (plan.hydrated.length > 0) this.#scheduleEviction();
    if (this.#inFlight === 0) return;
    for (const packet of plan.content) {
      const key = rowKey(packet.model, packet.id);
      const before = this.#since.get(key);
      if (before === undefined || before.version < packet.version) this.#since.set(key, packet);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  #want(parent: string): void {
    this.#wanted.set(parent, (this.#wanted.get(parent) ?? 0) + 1);
  }

  #unwant(parent: string): void {
    const count = (this.#wanted.get(parent) ?? 0) - 1;
    if (count > 0) {
      this.#wanted.set(parent, count);
      return;
    }
    this.#wanted.delete(parent);
    this.#stopRetry(parent);
    this.#unhold(parent);
    // Its next open starts afresh: a replica read shows loading again.
    runInAction(() => this.#unavailable.delete(parent));
    // Closed, it may be evicted now: the cache may have filled while it was open.
    this.#scheduleEviction();
  }

  /**
   * The content lock of a wanted parent (§5.4), taken shared on its first load, once the store
   * knows its storage: no tab evicts the parent while this tab has it open. Settles once granted
   * (an eviction holding it finishes first), or at once without locks.
   */
  #lock(parent: string): Promise<unknown> {
    if (!this.#wanted.has(parent)) return Promise.resolve();
    const held = this.#holds.get(parent);
    if (held !== undefined) return held;
    const locks = this.#host.sharedStorage() ? this.#host.locks() : undefined;
    if (locks === undefined) return Promise.resolve();
    const name = contentLockName(this.#host.replica, parent);
    const hold = holdShared(locks, name, this.#lockAbort.signal).catch(() => undefined);
    this.#holds.set(parent, hold);
    return hold;
  }

  #unhold(parent: string): void {
    const hold = this.#holds.get(parent);
    if (hold === undefined) return;
    this.#holds.delete(parent);
    void hold.then((release) => release?.());
  }

  /** Load until a result that isn't overtaken by a start or resync. */
  async #settle(parent: string): Promise<LoadResult> {
    for (;;) {
      if (this.#closed.get()) return 'stale';
      // Not before the store has a replica: the pool can't tell yet whether the parent is held.
      await when(() => this.#host.ready() || this.#closed.get());
      if (this.#closed.get()) return 'stale';
      await this.#lock(parent);
      if (this.#closed.get()) return 'stale';
      const result = await this.#loadOnce(parent);
      if (result !== 'stale') {
        if (result === 'failed') this.#scheduleRetry(parent);
        else if (result === 'ready' || result === 'missing') this.#stopRetry(parent);
        const unavailable = result === 'offline' || (result === 'failed' && !this.#reachableNow());
        runInAction(() => {
          if (unavailable) this.#unavailable.add(parent);
          else this.#unavailable.delete(parent);
        });
        return result;
      }
    }
  }

  #loadOnce(parent: string): Promise<LoadResult> {
    const running = this.#loads.get(parent);
    if (running !== undefined) return running;
    const load = this.#load(parent).finally(() => {
      if (this.#loads.get(parent) === load) this.#loads.delete(parent);
    });
    this.#loads.set(parent, load);
    return load;
  }

  async #load(parent: string): Promise<LoadResult> {
    const epoch = this.#epoch.get();
    if (this.#paged.has(parent)) return 'ready';
    // A prefetch of it in flight: its answer is stored first, then paged in from there.
    const prefetched = this.#prefetching.get(parent);
    if (prefetched !== undefined) {
      await prefetched;
      if (epoch !== this.#epoch.get()) return 'stale';
    }
    // §5.7: content needs the team's subscription; opening the issue subscribes its team.
    const team = this.#teamOf(parent);
    if (team !== undefined && !this.#host.followedTeams().has(team)) {
      // Before the socket dials, no public team is acked yet: wait for it (E11).
      await this.#fetchable(epoch);
      if (epoch !== this.#epoch.get()) return 'stale';
      if (!this.#host.followedTeams().has(team)) {
        this.#host.openTeam(team);
        await this.#host.whenTeamLoaded(team);
        if (epoch !== this.#epoch.get()) return 'stale';
        if (!this.#host.followedTeams().has(team)) return this.#online() ? 'missing' : 'offline';
      }
    }
    const local = await this.#pageIn(parent, epoch);
    if (local !== 'absent') return local;
    const fetchable = await this.#fetchable(epoch);
    if (epoch !== this.#epoch.get()) return 'stale';
    if (!fetchable) return 'offline';
    if (!this.#inBase(parent)) {
      if (!this.#inView(parent)) return this.#miss(parent, true);
      // Only this tab's overlay holds it (a create not confirmed yet): its `I` hydrates it.
      await when(
        () =>
          this.#paged.has(parent) ||
          !this.#inView(parent) ||
          this.#inBase(parent) ||
          epoch !== this.#epoch.get() ||
          !(this.#online() || this.#dialing()),
      );
      if (epoch !== this.#epoch.get()) return 'stale';
      if (this.#paged.has(parent)) return 'ready';
      if (!(await this.#fetchable(epoch))) {
        return epoch === this.#epoch.get() ? 'offline' : 'stale';
      }
      if (epoch !== this.#epoch.get()) return 'stale';
      if (!this.#inBase(parent)) return this.#miss(parent, true);
      // The `I` arrived without hydrating it (its team isn't followed here): fetch it.
    }
    return this.#fetch(parent, epoch);
  }

  #miss(parent: string, absent = false): LoadResult {
    if (absent) this.#absent.add(parent);
    else this.#absent.delete(parent);
    runInAction(() => this.#missing.add(parent));
    return 'missing';
  }

  /** Read a parent stored hydrated (another tab's, or an earlier load's) into the pool. */
  async #pageIn(parent: string, epoch: number): Promise<'ready' | 'stale' | 'absent'> {
    const persistence = this.#host.persistence();
    // Only from this tab's own generation: it holds every packet this tab applied. Once another
    // tab re-bootstrapped the replica (this tab is fenced), what is stored may lag this tab's
    // pool, and a paged-in row could come back after its `D`; fetch instead.
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined) return 'absent';
    this.#begin(parent);
    try {
      const read = await this.#host
        .enqueue(() =>
          persistence.writeReplica(generation, (storage) =>
            storage.readContent(generation, parent),
          ),
        )
        .catch(() => undefined);
      if (epoch !== this.#epoch.get()) return 'stale';
      if (read?.hydrated !== true || !this.#inBase(parent)) return 'absent';
      // The read saw every write queued before it; later packets are in `#since` (floor 0).
      const rows = read.records.map((record): LoadedRow => record);
      this.#merge(new Set([parent]), rows, 0);
      runInAction(() => this.#paged.add(parent));
      return 'ready';
    } finally {
      this.#end(parent, epoch);
    }
  }

  /** Fetch a parent from the server and store it (§5.3 steps 1–3). */
  async #fetch(parent: string, epoch: number): Promise<LoadResult> {
    this.#begin(parent);
    runInAction(() => this.#fetching.add(parent));
    try {
      let answer: ContentAnswer;
      try {
        answer = await this.#host.fetchContent([parent], this.#abort.signal);
      } catch (error) {
        if (epoch !== this.#epoch.get()) return 'stale';
        if (error instanceof ClientOutdatedError) this.#host.outdated();
        else if (this.#dialing()) {
          // Cut as a resync stopped the socket, which dials again soon: load again then (E11).
          await this.#fetchable(epoch);
          return 'stale';
        }
        // Cut by the connection going down (or failed with it): it loads when back online.
        if (!this.#online()) return 'offline';
        // §5.3 step 3: a failed request drops the buffer and the mark; a retry follows.
        return 'failed';
      }
      if (epoch !== this.#epoch.get()) return 'stale';
      const C = answer.lastSyncId;
      // E23: a parent purged meanwhile is skipped; so is one whose team this tab stopped following.
      const accepted = new Set(
        answer.parents.filter((id) => this.#inBase(id) && this.#teamAllowsParent(id)),
      );
      const rows = answer.rows
        .filter((r) => accepted.has(this.#parentOf(r.model, r.row) ?? ''))
        .map((r): LoadedRow => ({ ...r, version: C }));
      const replay = this.#merge(accepted, rows, C);
      runInAction(() => {
        for (const id of accepted) this.#paged.add(id);
      });
      this.#store(accepted, rows, C, replay);
      this.#scheduleEviction();
      if (accepted.has(parent) || this.#paged.has(parent)) return 'ready';
      // Gone from the pool meanwhile (deleted, purged): it loads again if it comes back.
      return this.#miss(parent, !this.#inBase(parent));
    } finally {
      runInAction(() => this.#fetching.delete(parent));
      this.#end(parent, epoch);
    }
  }

  #begin(parent: string): void {
    this.#inFlight += 1;
    runInAction(() => {
      this.#loading.add(parent);
      this.#missing.delete(parent);
    });
  }

  /** A load of `epoch` ended. One a start or resync overtook was already forgotten (`#newEpoch`). */
  #end(parent: string, epoch: number): void {
    if (epoch !== this.#epoch.get()) return;
    this.#inFlight -= 1;
    runInAction(() => this.#loading.delete(parent));
    if (this.#inFlight === 0) this.#since.clear();
  }

  /**
   * Put loaded rows into the pool: each row at the newer of its loaded version and the last
   * packet since the load began; then the buffered upserts of `parents` for rows not loaded
   * (§5.3 step 3: replay above `C`). Returns those buffered upserts above `floor`, for storage.
   */
  #merge(parents: ReadonlySet<string>, rows: readonly LoadedRow[], floor: number): StoredChange[] {
    const changes: BaseChange[] = [];
    const loaded = new Set<string>();
    for (const { model, row, archived, version } of rows) {
      const key = rowKey(model, row.id);
      loaded.add(key);
      const later = this.#since.get(key);
      if (later !== undefined && later.version > version) {
        // A `D` (or an upsert the pool took) is applied already; a buffered upsert goes now.
        if (!later.inPool && later.stored.kind !== 'delete') {
          // Its kind kept: a buffered `A` or `V` sets the archive flag too.
          changes.push({ kind: later.stored.kind, model, row: later.stored.row });
        }
        continue;
      }
      changes.push({ kind: archived ? 'archive' : 'unarchive', model, row });
    }
    const replay: StoredChange[] = [];
    for (const [key, packet] of this.#since) {
      if (packet.parent === undefined || !parents.has(packet.parent)) continue;
      if (packet.version <= floor || packet.stored.kind === 'delete') continue;
      replay.push(packet.stored);
      if (loaded.has(key) || packet.inPool) continue;
      changes.push({ kind: packet.stored.kind, model: packet.model, row: packet.stored.row });
    }
    this.#host.applyBase(changes);
    return replay;
  }

  /**
   * Store an answer at `C` with the packets buffered above it (storage dropped them), in one
   * transaction: no tab reads the parent hydrated without them (PLAN-011 S5b review B1).
   */
  #store(
    parents: ReadonlySet<string>,
    rows: readonly LoadedRow[],
    C: number,
    replay: readonly StoredChange[],
  ): void {
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined || parents.size === 0) return;
    const write: ContentWrite = {
      parents: [...parents],
      rows: rows.map(({ model, row, archived }) => ({ model, row, archived })),
      version: C,
      openedAt: this.#host.clock(),
      replay: [...replay].sort((a, b) => a.version - b.version),
    };
    void this.#host
      .enqueue(() =>
        persistence.writeReplica(generation, (storage) => storage.writeContent(generation, write)),
      )
      .catch(() => undefined);
  }

  /**
   * Load an open parent again after a failed load, on the socket's backoff: one record per parent,
   * whose attempt grows with each failure until a load succeeds or the parent is released.
   */
  #scheduleRetry(parent: string): void {
    if (!this.#wanted.has(parent)) return;
    const previous = this.#retries.get(parent);
    if (previous?.timer !== undefined) return;
    const attempt = previous?.attempt ?? 0;
    const timer = this.#host.timers.setTimeout(
      () => {
        if (this.#retries.get(parent)?.timer !== timer) return;
        // Fired: the next failure schedules attempt + 1.
        this.#retries.set(parent, { timer: undefined, attempt: attempt + 1 });
        if (!this.#wanted.has(parent) || this.#paged.has(parent)) return;
        void this.#settle(parent);
      },
      backoffDelay(attempt, this.#host.random()),
    );
    this.#retries.set(parent, { timer, attempt });
  }

  #stopRetry(parent: string): void {
    const retry = this.#retries.get(parent);
    if (retry?.timer !== undefined) this.#host.timers.clearTimeout(retry.timer);
    this.#retries.delete(parent);
  }

  /** Open parents not in the pool load again (after a start, or back online). */
  #reloadWanted(): void {
    if (this.#closed.get() || !this.#host.ready()) return;
    for (const parent of this.#wanted.keys()) {
      if (!this.#paged.has(parent) && !this.#loads.has(parent)) void this.#settle(parent);
    }
  }

  #newEpoch(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
    for (const retry of this.#retries.values()) this.#host.timers.clearTimeout(retry.timer);
    this.#retries.clear();
    this.#loads.clear();
    this.#since.clear();
    this.#absent.clear();
    // The prefetch queue stays: what was asked for is still wanted after a resync, and pumps
    // again once the store is ready and online (`reset`).
    this.#inFlight = 0;
    runInAction(() => {
      this.#epoch.set(this.#epoch.get() + 1);
      this.#paged.clear();
      this.#loading.clear();
      this.#fetching.clear();
      this.#unavailable.clear();
      this.#missing.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Prefetch (SPEC-011 §5.4)

  /**
   * Fetch and store these parents' content, so opening them later reads the replica (§5.4). Only
   * issues the pool holds, of teams this tab follows (§5.7), not open, paged in, loading or
   * hydrated already; never paged in here (the pool stays small). At most `MAX_CONTENT_PARENTS`
   * per request and `PREFETCH_REQUESTS` in flight, in the order asked. A parent that can't be
   * fetched yet (the store not online, its issue or team not loaded) waits in the queue until it
   * can. Best effort: a request that fails online is dropped, and the next prefetch or open asks
   * again (§5.3 step 3).
   */
  prefetch(parents: readonly string[]): void {
    if (this.#closed.get() || !this.enabled) return;
    const queue = [...this.#prefetchQueue];
    const queued = new Set(queue);
    for (const raw of parents) {
      const parent = raw.toLowerCase();
      if (queued.has(parent) || this.#underway(parent)) continue;
      queued.add(parent);
      queue.push(parent);
    }
    this.#setQueue(queue.slice(-PREFETCH_QUEUE_LIMIT));
    this.#pumpPrefetch();
  }

  #setQueue(queue: readonly string[]): void {
    this.#prefetchQueue.splice(0, this.#prefetchQueue.length, ...queue);
    runInAction(() => this.#prefetchQueued.set(this.#prefetchQueued.get() + 1));
  }

  /** Put parents back first in line (asked for before anything queued since), unless closed. */
  #requeue(parents: readonly string[]): void {
    if (this.#closed.get()) return;
    const back = parents.filter((p) => !this.#prefetchQueue.includes(p) && !this.#underway(p));
    if (back.length === 0) return;
    this.#setQueue([...back, ...this.#prefetchQueue].slice(0, PREFETCH_QUEUE_LIMIT));
  }

  /**
   * Observable: how many queued parents could be requested now (0 while the store isn't ready
   * and online). The pump's reaction runs as it grows: the socket came up, a team was acked, an
   * issue arrived.
   */
  #prefetchWaiting(): number {
    this.#prefetchQueued.get();
    if (this.#closed.get() || !this.#host.ready() || this.#host.connection() !== 'online') {
      return 0;
    }
    const followed = this.#host.followedTeams();
    const rules = this.#host.rules;
    let waiting = 0;
    for (const parent of this.#prefetchQueue) {
      if (!this.#inView(parent)) continue;
      const issue = rules === undefined ? undefined : this.#host.pool.get(rules.issue, parent);
      const team = issue === undefined ? undefined : teamOf(rowOf(issue));
      if (team === undefined || followed.has(team)) waiting += 1;
    }
    return waiting;
  }

  #pumpPrefetch(): void {
    if (this.#closed.get() || !this.#host.ready() || this.#host.connection() !== 'online') return;
    let rest = this.#prefetchQueue.filter((parent) => !this.#underway(parent));
    while (this.#prefetchRequests < PREFETCH_REQUESTS) {
      // Those that can't be fetched yet wait, in their place, for the issue or its team.
      const batch: string[] = [];
      const waiting: string[] = [];
      for (const parent of rest) {
        if (batch.length < MAX_CONTENT_PARENTS && this.#prefetchable(parent)) batch.push(parent);
        else waiting.push(parent);
      }
      rest = waiting;
      if (batch.length === 0) break;
      this.#prefetchRequests += 1;
      void this.#prefetchBatch(batch)
        .catch(() => undefined)
        .finally(() => {
          this.#prefetchRequests -= 1;
          this.#pumpPrefetch();
        });
    }
    if (rest.length !== this.#prefetchQueue.length) this.#setQueue(rest);
  }

  /** Whether a parent is open, paged in, loading or being prefetched: it is or will be hydrated. */
  #underway(parent: string): boolean {
    return untracked(
      () =>
        this.#wanted.has(parent) ||
        this.#paged.has(parent) ||
        this.#loads.has(parent) ||
        this.#prefetching.has(parent),
    );
  }

  /** Whether a parent may be prefetched now (before the storage check). Untracked. */
  #prefetchable(parent: string): boolean {
    return untracked(
      () => this.#inBase(parent) && this.#teamAllowsParent(parent) && !this.#underway(parent),
    );
  }

  async #prefetchBatch(batch: readonly string[]): Promise<void> {
    const epoch = this.#epoch.get();
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined) {
      // Nowhere to store it yet (a resync between replicas): it waits for the next reset.
      this.#requeue(batch);
      return;
    }
    const stored = await this.#host.enqueue(() =>
      persistence.writeReplica(generation, (storage) => storage.readHydrated()),
    );
    // A resync, or the socket dropped meanwhile: asked again once it is back.
    if (epoch !== this.#epoch.get() || this.#host.connection() !== 'online') {
      this.#requeue(batch);
      return;
    }
    if (stored === undefined) return;
    const hydrated = new Set(stored);
    const parents = batch.filter((parent) => !hydrated.has(parent) && this.#prefetchable(parent));
    if (parents.length === 0) return;
    let finish: () => void = () => undefined;
    const request = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const parent of parents) {
      this.#prefetching.set(parent, request);
      this.#begin(parent);
    }
    let again: readonly string[] = [];
    try {
      let answer: ContentAnswer;
      try {
        answer = await this.#host.fetchContent(parents, this.#abort.signal);
      } catch (error) {
        if (epoch === this.#epoch.get() && error instanceof ClientOutdatedError) {
          this.#host.outdated();
          return;
        }
        // Cut by a resync or the connection going down: asked again once it is back.
        again = epoch !== this.#epoch.get() || !this.#online() ? parents : [];
        return;
      }
      if (epoch !== this.#epoch.get()) {
        again = parents;
        return;
      }
      const C = answer.lastSyncId;
      // As an open's answer (§5.3 step 3): parents purged meanwhile, or of a team no longer
      // followed, are skipped with their rows (E23).
      const accepted = new Set(
        answer.parents.filter((id) => this.#inBase(id) && this.#teamAllowsParent(id)),
      );
      const rows = answer.rows
        .filter((r) => accepted.has(this.#parentOf(r.model, r.row) ?? ''))
        .map((r): LoadedRow => ({ ...r, version: C }));
      this.#store(accepted, rows, C, this.#replayOf(accepted, C));
      // D16: the parents after the last one taken may only have been left out for the answer's
      // size, so they are asked again; an invisible one among them at most until it leads.
      again = leftOutParents(parents, answer.parents);
      this.#scheduleEviction();
    } finally {
      for (const parent of parents) {
        this.#end(parent, epoch);
        if (this.#prefetching.get(parent) === request) this.#prefetching.delete(parent);
      }
      finish();
      // Here, once no longer underway, so a request cut short is put back too.
      this.#requeue(again);
    }
  }

  /** The buffered upserts of `parents` above `floor` (§5.3 step 3: replay above `C`). */
  #replayOf(parents: ReadonlySet<string>, floor: number): StoredChange[] {
    const replay: StoredChange[] = [];
    for (const packet of this.#since.values()) {
      if (packet.parent === undefined || !parents.has(packet.parent)) continue;
      if (packet.version <= floor || packet.stored.kind === 'delete') continue;
      replay.push(packet.stored);
    }
    return replay;
  }

  // ---------------------------------------------------------------------------
  // Cache size (SPEC-011 §5.4, Q11)

  /** A tab opened `parent`: it moves up in the cache's order (least recently opened go first). */
  #touch(parent: string): void {
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined || !this.#paged.has(parent)) return;
    const openedAt = this.#host.clock();
    void this.#host
      .enqueue(() =>
        persistence.writeReplica(generation, (storage) =>
          storage.touchContent(generation, [parent], openedAt),
        ),
      )
      .catch(() => undefined);
  }

  /** Evict past the limit once the writes queued now are done; one eviction at a time. */
  #scheduleEviction(): void {
    if (this.#evicting !== undefined) {
      this.#evictAgain = true;
      return;
    }
    this.#evicting = this.#evict()
      .catch(() => undefined)
      .finally(() => {
        this.#evicting = undefined;
        if (!this.#evictAgain) return;
        this.#evictAgain = false;
        this.#scheduleEviction();
      });
  }

  /**
   * Evict the least recently opened parents past `cacheLimit` (§5.4): never one open in this tab,
   * nor one whose lock another tab holds (taken exclusively with `ifAvailable`, kept until the
   * eviction is written). Without Web Locks on shared storage another tab may have a parent open
   * unseen, so nothing is evicted. Memory storage is this tab's alone: no locks needed.
   */
  async #evict(): Promise<void> {
    if (this.#closed.get() || !this.#host.ready()) return;
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined) return;
    const shared = this.#host.sharedStorage();
    const locks = shared ? this.#host.locks() : undefined;
    if (shared && locks === undefined) return;
    const marks = await this.#host.enqueue(() =>
      persistence.writeReplica(generation, (storage) => storage.readContentMarks()),
    );
    if (marks === undefined) return;
    const excess = marks.length - this.#host.cacheLimit;
    if (excess <= 0) return;
    const oldest = [...marks].sort(
      (a, b) => a.openedAt - b.openedAt || (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0),
    );
    const chosen: ContentMark[] = [];
    const releases: (() => void)[] = [];
    try {
      for (const mark of oldest) {
        if (chosen.length >= excess) break;
        if (this.#wanted.has(mark.parent)) continue;
        if (locks !== undefined) {
          const release = await tryHold(locks, contentLockName(this.#host.replica, mark.parent));
          // Open in another tab: skipped.
          if (release === undefined) continue;
          releases.push(release);
          // Opened here meanwhile (its shared request waits behind this one): kept.
          if (this.#wanted.has(mark.parent)) continue;
        }
        chosen.push(mark);
      }
      if (chosen.length === 0 || this.#closed.get()) return;
      const evicted = await this.#host.enqueue(() =>
        persistence.writeReplica(generation, (storage) => storage.evictContent(generation, chosen)),
      );
      this.#dropPaged(evicted ?? []);
    } finally {
      for (const release of releases) release();
    }
  }

  /**
   * Evicted parents paged in here but not open leave the pool too, so it doesn't keep growing.
   * One opened meanwhile stays: its pool rows are complete and live.
   */
  #dropPaged(evicted: readonly string[]): void {
    const parents = new Set(evicted.filter((p) => this.#paged.has(p) && !this.#wanted.has(p)));
    if (parents.size === 0) return;
    const changes: BaseChange[] = [];
    for (const [model, ref] of this.#byModel) {
      for (const { row } of this.#host.pool.baseRows(model)) {
        if (parents.has(String(row[ref.field])))
          changes.push({ kind: 'delete', model, id: row.id });
      }
    }
    runInAction(() => {
      for (const parent of parents) this.#paged.delete(parent);
    });
    this.#host.applyBase(changes);
  }

  // ---------------------------------------------------------------------------
  // Parents

  #online(): boolean {
    const connection = this.#host.connection();
    return connection === 'online' || connection === 'connecting';
  }

  /**
   * A ready store whose socket hasn't dialled yet: its teams are being prepared after a start, or
   * a resync runs. It is about to connect, so nothing is offline yet (E11). Observable.
   */
  #dialing(): boolean {
    return this.#host.connection() === 'disconnected' && this.#host.ready() && !this.#closed.get();
  }

  /** Whether content can be fetched, once a socket about to dial has (`#dialing`). */
  async #fetchable(epoch: number): Promise<boolean> {
    await when(() => !this.#dialing() || epoch !== this.#epoch.get());
    return this.#online();
  }

  /**
   * Online, or connecting (or about to) with no failed attempt since it was last online (E11).
   * Observable.
   */
  #reachableNow(): boolean {
    const connection = this.#host.connection();
    if (connection === 'online') return true;
    return (connection === 'connecting' || this.#dialing()) && this.#reachable.get();
  }

  /** The parent a mutation's `contentParent` names, lower-cased; `undefined` if not held. */
  #resolve(ref: ContentParentRef): string | undefined {
    return untracked(() => {
      const content = this.#byModel.get(ref.model);
      if (content !== undefined) {
        // `{ model: 'Comment', id }`: the comment's issue, read from the store (§5.3 step 6).
        const row = isUuid(ref.id)
          ? this.#host.pool.get(ref.model, ref.id.toLowerCase())
          : undefined;
        const parent = row === undefined ? undefined : rowOf(row)[content.field];
        return typeof parent === 'string' ? parent.toLowerCase() : undefined;
      }
      if (!this.#parentModels.has(ref.model)) return undefined;
      if (isUuid(ref.id)) return ref.id.toLowerCase();
      const type = REF_TYPE_OF_MODEL.get(ref.model);
      return type === undefined ? undefined : this.#host.resolveRef(type, ref.id);
    });
  }

  /** The parent a content row names. */
  #parentOf(model: string, row: ModelRow): string | undefined {
    const ref = this.#byModel.get(model);
    const parent = ref === undefined ? undefined : row[ref.field];
    return typeof parent === 'string' ? parent : undefined;
  }

  /** The base row of a parent, in whichever parent model holds it. */
  #baseRow(parent: string): { model: string; row: ModelRow } | undefined {
    for (const model of this.#parentModels) {
      const state = this.#host.pool.baseOf(model, parent);
      if (state !== undefined) return { model, row: state.row };
    }
    return undefined;
  }

  #inBase(parent: string): boolean {
    return this.#baseRow(parent) !== undefined;
  }

  /** Whether the pool shows the parent (base or overlay). Tracked: `when` waits on it. */
  #inView(parent: string): boolean {
    return [...this.#parentModels].some(
      (model) => this.#host.pool.get(model, parent) !== undefined,
    );
  }

  /** The team of an Issue parent, with partial loading on. */
  #teamOf(parent: string): string | undefined {
    const rules = this.#host.rules;
    if (rules === undefined || !this.#parentModels.has(rules.issue)) return undefined;
    const row = untracked(() => {
      const instance = this.#host.pool.get(rules.issue, parent);
      return instance === undefined ? undefined : rowOf(instance);
    });
    return row === undefined ? undefined : teamOf(row);
  }

  /** §5.3 step 5, §5.7: an Issue's content is held only while its team is followed here. */
  #teamAllows(model: string, row: ModelRow): boolean {
    const rules = this.#host.rules;
    if (rules === undefined || model !== rules.issue) return true;
    return untracked(() => this.#host.followedTeams()).has(teamOf(row) ?? '');
  }

  #teamAllowsParent(parent: string): boolean {
    const base = this.#baseRow(parent);
    return base !== undefined && this.#teamAllows(base.model, base.row);
  }
}

/** The visible rows of `model` whose `field` is `value`: by its index if it has one (a backRef's). */
function byField(pool: ObjectPool, model: string, field: string, value: string): ModelInstance[] {
  if (pool.hasIndex(model, field)) return pool.findBy(model, field, value);
  return pool.all(model).filter((row) => row[field] === value);
}

/**
 * SPEC-011 D16: the parents a multi-parent answer left out for its size budget. The server takes
 * whole parents in request order while they fit and stops at the first that doesn't, the first
 * visible one always. So a requested parent missing before the last one taken is unknown or
 * invisible, and those after it may only have been left out. An answer that took none left none
 * out: the first visible parent always comes.
 */
export function leftOutParents(
  requested: readonly string[],
  answered: readonly string[],
): string[] {
  const taken = new Set(answered);
  let last = -1;
  requested.forEach((parent, index) => {
    if (taken.has(parent)) last = index;
  });
  return last < 0 ? [] : requested.slice(last + 1);
}

// ---------------------------------------------------------------------------
// GET /sync/content

/** A content answer: `C`, the parents found and visible, and their rows (E15 applied). */
export interface ContentAnswer {
  readonly lastSyncId: number;
  readonly parents: readonly string[];
  readonly rows: readonly {
    readonly model: string;
    readonly row: ModelRow;
    readonly archived: false;
  }[];
}

export interface ContentRequest {
  readonly fetch: FetchLike;
  readonly baseUrl: string;
  readonly userId: string;
  readonly schemaHash: string;
  readonly parents: readonly string[];
  readonly pool: ObjectPool;
  readonly models: readonly ContentModelRef[];
  readonly signal?: AbortSignal;
  readonly timers?: Timers;
}

/** The content request failed; `status` is the HTTP status when there was a response. */
export class ContentFailedError extends Error {
  override readonly name = 'ContentFailedError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * `GET /sync/content` (SPEC-011 §5.2), read whole (at most 50 parents). `ClientOutdatedError` on
 * `426`; `ProtocolError` on bad data or a cut stream; `ContentFailedError` otherwise. A row whose
 * parent isn't in the answer's `parents` is dropped (E15).
 */
export async function fetchContent(options: ContentRequest): Promise<ContentAnswer> {
  const parents = options.parents.map((id) => issueParent(id));
  const response = await requestNdjson(
    options,
    `${CONTENT_PATH}?${encodeContentQuery({
      parents,
      userId: options.userId,
      schemaHash: options.schemaHash,
    })}`,
  );
  if (response.status === 426) {
    await response.body?.cancel();
    throw new ClientOutdatedError();
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new ContentFailedError(
      `Could not load the issue's content (HTTP ${response.status})`,
      response.status,
    );
  }
  const byModel = new Map(options.models.map((ref) => [ref.model, ref]));
  const reader = new ContentStreamReader(parents);
  const decoder = new NdjsonDecoder();
  let found: ReadonlySet<string> = new Set();
  let lastSyncId = 0;
  const rows: { model: string; row: ModelRow; archived: false }[] = [];
  const handle = (value: unknown) => {
    const frame = reader.read(value);
    if (frame.t === 'meta') {
      lastSyncId = frame.lastSyncId;
      found = new Set(frame.parents.map(parentIssueId));
      return;
    }
    if (frame.t !== 'row') return;
    const ref = byModel.get(frame.m);
    if (ref === undefined) throw new ProtocolError(`Invalid content: unexpected model ${frame.m}`);
    const row = decodeRow(options.pool, frame.m, frame.d);
    if (found.has(String(row[ref.field]))) rows.push({ model: frame.m, row, archived: false });
  };
  const body = response.body.getReader();
  const { signal } = options;
  const cancel = () => {
    body.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await body.read();
      signal?.throwIfAborted();
      if (done) break;
      for (const item of decoder.push(value)) handle(item);
    }
    for (const item of decoder.end()) handle(item);
    reader.finish();
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    body.releaseLock();
  }
  return { lastSyncId, parents: [...found], rows };
}
