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
 */
import { isUuid, type RefType } from '@surface/domain';
import type { ModelDef, ModelRow } from '@surface/domain/model';
import type { ContentParentRef } from '@surface/operations';
import {
  CONTENT_PATH,
  ContentStreamReader,
  NdjsonDecoder,
  ProtocolError,
  encodeContentQuery,
  issueParent,
  parentIssueId,
} from '@surface/sync-protocol';
import type { IObservableValue, ObservableSet } from 'mobx';
import { observable, reaction, runInAction, untracked, when } from 'mobx';
import type { FetchLike } from './bootstrap.js';
import type { ModelInstance } from './instance.js';
import { fieldOf, rowOf } from './instance.js';
import { ClientOutdatedError, decodeRow, requestNdjson } from './bootstrap.js';
import type { ContentPacket, ContentRouting, DeltaPlan } from './deltas.js';
import type { PartialRules } from './partial.js';
import type { Persistence } from './persistence.js';
import type { BaseChange, ObjectPool } from './pool.js';
import type { ConnectionState, Timers } from './socket.js';
import { backoffDelay } from './socket.js';
import type { ContentModelRef, StoredChange } from './storage/types.js';
import { teamOf } from './storage/types.js';
import type { TeamLoadState } from './subscriptions.js';

/**
 * Whether a parent's content can be shown (SPEC-011 §5.3, E11): `ready` once paged in (or there is
 * nothing to load: a parent the server doesn't show), `loading` until then, `offline` when it was
 * never hydrated and can't be fetched now ("Available when online").
 */
export type ContentLoadState = 'loading' | 'ready' | 'offline';

/** An open parent (`content.open`). */
export interface ContentHandle {
  /** Settles once the parent is paged in, or can't be now: its load state then. */
  readonly ready: Promise<ContentLoadState>;
  /** The view closed. Repeated calls do nothing. (PLAN-011 S7 frees the parent's lock here.) */
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

/** The content models of `models`, with their parents (`defineModel`'s `parent`). */
export function contentModels(models: readonly ModelDef[]): ContentModelRef[] {
  return models.flatMap((def) =>
    def.load === 'content' && def.parent !== undefined
      ? [{ model: def.name, field: String(def.parent.field), parent: def.parent.model }]
      : [],
  );
}

/** What content hydration needs from its store. */
export interface ContentHost {
  readonly pool: ObjectPool;
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

/** What dispatch does after `ensure`. */
export type EnsureResult = 'proceed' | 'unavailable' | 'closed';

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
  /** Retries of failed loads of open parents, per parent. */
  readonly #retries = new Map<string, { timer: unknown; attempt: number }>();
  #stopOnline: (() => void) | undefined;
  #stopFound: (() => void) | undefined;
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
    if (this.#loading.has(id) || !this.#host.ready()) return 'loading';
    const connection = this.#host.connection();
    return connection === 'online' || connection === 'connecting' ? 'loading' : 'offline';
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
    const ready = this.#settle(id).then(() => this.state(id));
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
      return this.#online() ? 'proceed' : 'unavailable';
    }
    if (this.#paged.has(parent)) return 'proceed';
    this.#want(parent);
    try {
      const result = await this.#settle(parent);
      if (this.#closed.get()) return 'closed';
      return result === 'ready' || result === 'missing' ? 'proceed' : 'unavailable';
    } finally {
      this.#unwant(parent);
    }
  }

  // ---------------------------------------------------------------------------
  // Store life cycle

  /** After a start or resync (§5.3 step 7): nothing is paged in; open parents load again. */
  reset(): void {
    this.#newEpoch();
    runInAction(() => this.#closed.set(false));
    this.#stopOnline ??= reaction(
      () => this.#host.ready() && this.#online(),
      (up) => {
        if (up) this.#reloadWanted();
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
    void Promise.resolve().then(() => this.#reloadWanted());
  }

  close(): void {
    this.#newEpoch();
    runInAction(() => this.#closed.set(true));
    this.#stopOnline?.();
    this.#stopOnline = undefined;
    this.#stopFound?.();
    this.#stopFound = undefined;
  }

  /** An unsubscribe or a sweep removed these issues' content from the pool (§5.7). */
  forget(parents: Iterable<string>): void {
    runInAction(() => {
      for (const parent of parents) {
        this.#paged.delete(parent);
        this.#missing.delete(parent);
      }
    });
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
      }
    });
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
    const retry = this.#retries.get(parent);
    if (retry !== undefined) this.#host.timers.clearTimeout(retry.timer);
    this.#retries.delete(parent);
  }

  /** Load until a result that isn't overtaken by a start or resync. */
  async #settle(parent: string): Promise<LoadResult> {
    for (;;) {
      if (this.#closed.get()) return 'stale';
      // Not before the store has a replica: the pool can't tell yet whether the parent is held.
      await when(() => this.#host.ready() || this.#closed.get());
      if (this.#closed.get()) return 'stale';
      const result = await this.#loadOnce(parent);
      if (result !== 'stale') {
        if (result === 'failed') this.#scheduleRetry(parent);
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
    // §5.7: content needs the team's subscription; opening the issue subscribes its team.
    const team = this.#teamOf(parent);
    if (team !== undefined && !this.#host.followedTeams().has(team)) {
      this.#host.openTeam(team);
      await this.#host.whenTeamLoaded(team);
      if (epoch !== this.#epoch.get()) return 'stale';
      if (!this.#host.followedTeams().has(team)) return this.#online() ? 'missing' : 'offline';
    }
    const local = await this.#pageIn(parent, epoch);
    if (local !== 'absent') return local;
    if (!this.#online()) return 'offline';
    if (!this.#inBase(parent)) {
      if (!this.#inView(parent)) return this.#miss(parent, true);
      // Only this tab's overlay holds it (a create not confirmed yet): its `I` hydrates it.
      await when(
        () =>
          this.#paged.has(parent) ||
          !this.#inView(parent) ||
          this.#inBase(parent) ||
          epoch !== this.#epoch.get() ||
          !this.#online(),
      );
      if (epoch !== this.#epoch.get()) return 'stale';
      if (this.#paged.has(parent)) return 'ready';
      if (!this.#online()) return 'offline';
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
    try {
      let answer: ContentAnswer;
      try {
        answer = await this.#host.fetchContent([parent], this.#abort.signal);
      } catch (error) {
        if (epoch !== this.#epoch.get()) return 'stale';
        if (error instanceof ClientOutdatedError) this.#host.outdated();
        // §5.3 step 3: a failed request drops the buffer and the mark; the next open retries.
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
      if (accepted.has(parent) || this.#paged.has(parent)) return 'ready';
      return this.#miss(parent);
    } finally {
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
          changes.push({ kind: 'upsert', model, row: later.stored.row });
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
      changes.push({ kind: 'upsert', model: packet.model, row: packet.stored.row });
    }
    this.#host.applyBase(changes);
    return replay;
  }

  /** Store an answer at `C`, then the packets buffered above it (storage dropped them). */
  #store(
    parents: ReadonlySet<string>,
    rows: readonly LoadedRow[],
    C: number,
    replay: readonly StoredChange[],
  ): void {
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined || parents.size === 0) return;
    const write = {
      parents: [...parents],
      rows: rows.map(({ model, row, archived }) => ({ model, row, archived })),
      version: C,
      openedAt: this.#host.clock(),
    };
    void this.#host
      .enqueue(() =>
        persistence.writeReplica(generation, (storage) => storage.writeContent(generation, write)),
      )
      .catch(() => undefined);
    if (replay.length === 0) return;
    const sorted = [...replay].sort((a, b) => a.version - b.version);
    const last = sorted.at(-1)?.version ?? C;
    void this.#host
      .enqueue(() =>
        persistence.writeReplica(generation, (storage) =>
          storage.applyChanges(generation, sorted, last),
        ),
      )
      .catch(() => undefined);
  }

  #scheduleRetry(parent: string): void {
    if (!this.#wanted.has(parent) || this.#retries.has(parent)) return;
    const attempt = this.#retries.get(parent)?.attempt ?? 0;
    const timer = this.#host.timers.setTimeout(
      () => {
        const entry = this.#retries.get(parent);
        this.#retries.delete(parent);
        if (!this.#wanted.has(parent) || this.#paged.has(parent)) return;
        void this.#settle(parent).then((result) => {
          if (result === 'failed' && entry !== undefined) {
            this.#retries.set(parent, { timer: undefined, attempt: entry.attempt + 1 });
          }
        });
      },
      backoffDelay(attempt, this.#host.random()),
    );
    this.#retries.set(parent, { timer, attempt });
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
    this.#inFlight = 0;
    runInAction(() => {
      this.#epoch.set(this.#epoch.get() + 1);
      this.#paged.clear();
      this.#loading.clear();
      this.#missing.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Parents

  #online(): boolean {
    const connection = this.#host.connection();
    return connection === 'online' || connection === 'connecting';
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
  try {
    return pool.findBy(model, field, value);
  } catch {
    return pool.all(model).filter((row) => row[field] === value);
  }
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
