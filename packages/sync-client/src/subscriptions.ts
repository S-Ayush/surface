/**
 * Team subscriptions, the client half of partial issue loading (SPEC-011 §5.7, ADR-0020,
 * PLAN-011 S4c). One per store (tab).
 *
 * A tab follows the private teams the user is a member of (home groups, always on the
 * connection), and subscribes to public teams: the ones the user is a member of (from the
 * membership rows, live) and up to 5 others opened on demand (least recently opened dropped).
 * The on-demand list is kept in storage, shared by the replica's tabs, so a new tab starts with
 * it; each tab then keeps its own.
 *
 * - **Subscribe:** the socket URL names the teams (`teams=`), or `subscribe` on an open socket.
 *   After the `subscribed` ack, a team whose rows this tab doesn't hold current is loaded with
 *   the partial bootstrap. Packets that arrive meanwhile apply at once (E30); the answer then
 *   skips every row a packet above its `C` changed (`touched`), and storage writes it through
 *   `writePartialRows`, whose version rule does the same.
 * - **Current:** a team whose rows this tab holds complete through its applied id. Its
 *   `teamThrough` moves with each storage write. At a warm start a team is current only if its
 *   `teamThrough` has reached the replica's `lastSyncId`; otherwise it is loaded again and swept
 *   (E35).
 * - **Unsubscribe:** `unsubscribe`, and only on the `unsubscribed` ack (or, if the socket dropped,
 *   at the next connection, which no longer names the team) are its rows removed: from this tab's
 *   pool always, from storage only under the exclusive team lock, skipped while another tab
 *   follows the team (E36), and never without Web Locks.
 */
import type {
  ClientMessage,
  SubscribedMessage,
  SyncGroup,
  UnsubscribedMessage,
} from '@surface/sync-protocol';
import { MAX_TEAMS_PER_MESSAGE } from '@surface/sync-protocol';
import type { IObservableArray, IObservableValue, ObservableMap, ObservableSet } from 'mobx';
import { computed, observable, reaction, runInAction, when } from 'mobx';
import { ClientOutdatedError } from './bootstrap.js';
import type { DeltaPlan } from './deltas.js';
import type { ReplicaLocks } from './locks.js';
import { holdShared, teamLockName, tryHold } from './locks.js';
import type { PartialAnswer, PartialRules } from './partial.js';
import { isRemovedIssue } from './partial.js';
import type { Persistence } from './persistence.js';
import type { BaseChange, ObjectPool } from './pool.js';
import type { ConnectionState, Timers } from './socket.js';
import { backoffDelay } from './socket.js';
import { meetsGroups, teamOf } from './storage/types.js';

/**
 * Whether a team's issues can be shown (SPEC-011 §5.7 "what stays local"): `ready` once loaded
 * (or nothing to load), `loading` until its partial bootstrap is applied, `offline` when it
 * can't be loaded now and never was (E34: "Available when online").
 */
export type TeamLoadState = 'loading' | 'ready' | 'offline';

/** What the subscriptions need from their store. */
export interface SubscriptionHost {
  readonly pool: ObjectPool;
  readonly userId: string;
  readonly rules: PartialRules;
  readonly replica: string;
  /** On-demand teams kept at most (5, SPEC-011 §5.7). */
  readonly limit: number;
  readonly timers: Timers;
  readonly random: () => number;
  /** Web Locks for shared storage; `undefined` without them, or for memory storage. */
  locks(): ReplicaLocks | undefined;
  /** Whether storage is shared by tabs (IndexedDB); memory storage is this tab's alone. */
  sharedStorage(): boolean;
  /** Send on the open socket; false when none is open. */
  send(message: ClientMessage): boolean;
  /** Observable. */
  connection(): ConnectionState;
  /** The tab's applied id while the store is ready; observable. */
  appliedId(): number | undefined;
  persistence(): Persistence | undefined;
  /** The generation storage writes go to, if any. */
  generation(): string | undefined;
  /** Run a storage write after the ones queued before it (the store's serial queue). */
  enqueue(task: () => Promise<unknown>): void;
  /** Apply server rows to the pool's base, rebuilding the overlay if it depends on them. */
  applyBase(changes: readonly BaseChange[]): void;
  fetchPartial(teams: readonly string[], signal: AbortSignal): Promise<PartialAnswer>;
  outdated(): void;
}

/** Where the replica stands after a start: a cold bootstrap's groups, or a warm start's cursors. */
export type ReplicaStart =
  | { readonly kind: 'cold'; readonly groups: readonly SyncGroup[] }
  | {
      readonly kind: 'warm';
      readonly lastSyncId: number;
      readonly teamThrough: Readonly<Record<string, number>> | undefined;
    };

interface Membership {
  readonly publicTeams: ReadonlySet<string>;
  readonly privateTeams: ReadonlySet<string>;
}

const key = (model: string, id: string) => `${model}\u0000${id}`;

export class TeamSubscriptions {
  readonly #host: SubscriptionHost;
  /** This tab's on-demand teams, most recently opened first. */
  readonly #onDemand: IObservableArray<string> = observable.array([], { deep: false });
  #onDemandRead = false;
  /** Teams whose shared team lock this tab holds (or doesn't need: no locks). */
  readonly #held: ObservableSet<string> = observable.set();
  readonly #holds = new Map<string, () => Promise<void>>();
  readonly #holding = new Set<string>();
  /** Teams the current connection follows (acked, not unsubscribed). */
  readonly #accepted: ObservableSet<string> = observable.set();
  /** Rows complete through this tab's applied id, and kept live. */
  readonly #current = new Set<string>();
  /** Rows this tab's pool holds from a completed load (current or not). Observable. */
  readonly #loaded: ObservableSet<string> = observable.set();
  /** Asked for and not accepted: unknown, or invisible (E32). Nothing to load. */
  readonly #refused: ObservableSet<string> = observable.set();
  /** Accepted, partial bootstrap pending: the attempt number. */
  readonly #loading: ObservableMap<string, number> = observable.map([], { deep: false });
  /** Bumped by `close()`: a lock or answer that arrives after it belongs to a closed store. */
  #lifetime = 0;
  /** Aborts the shared-lock requests still waiting when the store closes. */
  #lockAbort = new AbortController();
  readonly #closed: IObservableValue<boolean> = observable.box(false);
  /** `unsubscribe` sent, ack pending. */
  readonly #leaving = new Set<string>();
  /** Teams of each `subscribe` sent on this connection, in order (acks come in order). */
  #sent: (readonly string[])[] = [];
  /** The teams the current dial named on its URL, until its `subscribed` ack. */
  #asked: ReadonlySet<string> | undefined;
  /** Issue and child rows changed by packets while a load is pending: id → sync id. */
  readonly #touched = new Map<string, number>();
  /** Opened before the store was ready. */
  readonly #deferred: string[] = [];
  readonly #prepared: IObservableValue<boolean> = observable.box(false);
  #epoch = 0;
  #abort = new AbortController();
  #retry: unknown;
  #retryAttempt = 0;
  readonly #membership;
  #stopMembership: (() => void) | undefined;

  constructor(host: SubscriptionHost) {
    this.#host = host;
    this.#membership = computed((): Membership => this.#readMembership(), {
      equals: (a, b) =>
        sameSet(a.publicTeams, b.publicTeams) && sameSet(a.privateTeams, b.privateTeams),
    });
  }

  // ---------------------------------------------------------------------------
  // Reads

  /** The teams this tab wants to follow: member public teams and its on-demand teams. */
  get wanted(): ReadonlySet<string> {
    return new Set([...this.#membership.get().publicTeams, ...this.#onDemand]);
  }

  /**
   * Teams whose deltas this tab's connection receives: the private teams the user is a member
   * of and the accepted public teams. SPEC-011 §5.3 step 5 (PLAN-011 S5b): an Issue `I` marks
   * an issue hydrated only when its team is in here. Observable.
   */
  get followedTeams(): ReadonlySet<string> {
    return new Set([...this.#membership.get().privateTeams, ...this.#accepted]);
  }

  /**
   * Teams whose `teamThrough` this tab's writes advance: complete in its pool and received on its
   * connection (accepted). A team only stored, or not yet acked, must not move (E35).
   */
  currentTeams(): string[] {
    return [...this.#current].filter((team) => this.#accepted.has(team));
  }

  /** Observable; see `TeamLoadState`. */
  loadState(teamId: string): TeamLoadState {
    if (!this.#prepared.get() || this.#host.appliedId() === undefined) return 'loading';
    const team = this.#host.pool.get(this.#host.rules.team, teamId);
    // Nothing to load: an unknown team, or a private one (a member's is a home group).
    if (team === undefined || team['private'] === true) return 'ready';
    if (this.#loaded.has(teamId) || this.#refused.has(teamId)) return 'ready';
    const connection = this.#host.connection();
    return connection === 'online' || connection === 'connecting' ? 'loading' : 'offline';
  }

  /**
   * Resolves once `teamId` is loaded as far as it can be now: not `loading`, and, for a team this
   * tab follows, acked and with no partial bootstrap pending (a team found behind is reloading,
   * E35). Offline it resolves with the state it has. Resolves `loading` if the store closes first.
   */
  async whenLoaded(teamId: string): Promise<TeamLoadState> {
    await when(() => {
      if (this.#closed.get()) return true;
      const state = this.loadState(teamId);
      if (state !== 'ready') return state !== 'loading';
      const connection = this.#host.connection();
      if (connection !== 'online' && connection !== 'connecting') return true;
      const pending =
        this.wanted.has(teamId) &&
        !this.#refused.has(teamId) &&
        (!this.#accepted.has(teamId) || this.#loading.has(teamId));
      return !pending;
    });
    return this.#closed.get() ? 'loading' : this.loadState(teamId);
  }

  // ---------------------------------------------------------------------------
  // Start, connect, stop

  /**
   * After a cold or warm start and after a resync, before the socket connects: which teams
   * the pool holds current, from the full bootstrap's groups or the stored `teamThrough`.
   */
  reset(start: ReplicaStart): void {
    this.#cancelLoads();
    const { privateTeams } = this.#membership.get();
    const teams =
      start.kind === 'cold'
        ? start.groups.filter((g) => g.startsWith('team:')).map((g) => g.slice('team:'.length))
        : Object.keys(start.teamThrough ?? {});
    const current =
      start.kind === 'cold'
        ? teams
        : teams.filter((team) => (start.teamThrough?.[team] ?? -1) >= start.lastSyncId);
    runInAction(() => {
      this.#prepared.set(false);
      this.#accepted.clear();
      this.#refused.clear();
      this.#loaded.replace(teams.filter((team) => !privateTeams.has(team)));
    });
    this.#current.clear();
    for (const team of current) if (!privateTeams.has(team)) this.#current.add(team);
  }

  /**
   * Read the on-demand teams (once per store), apply teams opened while loading, drop from the
   * pool what this tab doesn't follow, and hold the shared lock of each wanted team.
   */
  async prepare(): Promise<void> {
    runInAction(() => this.#closed.set(false));
    const persistence = this.#host.persistence();
    if (!this.#onDemandRead && persistence !== undefined) {
      const stored = await persistence.write((storage) => storage.readOnDemand());
      this.#onDemandRead = true;
      if (stored !== undefined) {
        runInAction(() => this.#onDemand.replace(stored.slice(0, this.#host.limit)));
      }
    }
    for (const teamId of this.#deferred.splice(0)) this.#touch(teamId);
    this.#prune();
    await Promise.all([...this.wanted].map((team) => this.#hold(team)));
    // The cursors came from storage before the shared holds: another tab may have removed a
    // team's rows (and its cursor) since, under its exclusive lock (E36). Read them again now
    // that no tab can remove a team this one holds, and reload any team no longer complete.
    const meta = await this.#host.persistence()?.write((storage) => storage.readMeta());
    const applied = this.#host.appliedId();
    const followed = this.#followed();
    runInAction(() => {
      for (const team of [...this.#loaded]) if (!followed.has(team)) this.#loaded.delete(team);
    });
    for (const team of [...this.#current]) {
      const through = meta?.teamThrough?.[team];
      const complete = through !== undefined && applied !== undefined && through >= applied;
      // A team this tab doesn't follow was pruned from the pool: it must load when opened.
      if (!followed.has(team) || (meta !== undefined && !complete)) this.#current.delete(team);
    }
    this.#stopMembership ??= reaction(
      () => this.#membership.get().publicTeams,
      (now, before) => this.#membershipChanged(now, before),
    );
    runInAction(() => this.#prepared.set(true));
  }

  /** The `teams` of a new connection's URL. Called as the socket dials. */
  dialTeams(): string[] {
    const teams = [...this.wanted].filter((team) => this.#held.has(team));
    const named = teams.slice(0, MAX_TEAMS_PER_MESSAGE);
    this.#asked = new Set(named);
    this.#sent = [];
    this.#leaving.clear();
    runInAction(() => this.#accepted.clear());
    return named;
  }

  /** The store closed: stop loading, let go of the team locks. */
  close(): void {
    this.#lifetime += 1;
    this.#lockAbort.abort();
    this.#lockAbort = new AbortController();
    runInAction(() => this.#closed.set(true));
    this.#cancelLoads();
    this.#stopMembership?.();
    this.#stopMembership = undefined;
    for (const release of this.#holds.values()) void release();
    this.#holds.clear();
    runInAction(() => {
      this.#held.clear();
      this.#prepared.set(false);
      this.#accepted.clear();
    });
    this.#current.clear();
    this.#leaving.clear();
    this.#sent = [];
    this.#asked = undefined;
  }

  // ---------------------------------------------------------------------------
  // Opening teams

  /**
   * The user opened a team's list or one of its issues (SPEC-011 §5.7): a public team they
   * aren't a member of becomes the most recently opened on-demand team and is subscribed; the
   * least recently opened beyond the limit is unsubscribed (E31). Anything else is a no-op.
   */
  openTeam(teamId: string): void {
    if (!this.#prepared.get()) {
      if (!this.#deferred.includes(teamId)) this.#deferred.push(teamId);
      return;
    }
    if (this.#touch(teamId)) void this.#follow(teamId);
  }

  /** Update the on-demand list; true when `teamId` is newly wanted. */
  #touch(teamId: string): boolean {
    const team = this.#host.pool.get(this.#host.rules.team, teamId);
    if (team === undefined || team['private'] !== false) return false;
    const { publicTeams } = this.#membership.get();
    if (publicTeams.has(teamId)) return false;
    const before = new Set(this.wanted);
    const next = [teamId, ...this.#onDemand.filter((t) => t !== teamId)];
    const dropped = next.slice(this.#host.limit);
    runInAction(() => this.#onDemand.replace(next.slice(0, this.#host.limit)));
    const limit = this.#host.limit;
    void this.#host.persistence()?.write((storage) => storage.touchOnDemand(teamId, limit));
    for (const team of dropped) if (!publicTeams.has(team)) this.#leave(team);
    return !before.has(teamId);
  }

  #membershipChanged(now: ReadonlySet<string>, before: ReadonlySet<string>): void {
    if (!this.#prepared.get()) return;
    for (const team of now) if (!before.has(team)) void this.#follow(team);
    for (const team of before) {
      if (!now.has(team) && !this.#onDemand.includes(team)) this.#leave(team);
    }
  }

  /** Hold the team's lock, then subscribe on the open socket (or on the next dial's URL). */
  async #follow(team: string): Promise<void> {
    await this.#hold(team);
    if (!this.wanted.has(team) || !this.#held.has(team)) return;
    // A team whose `unsubscribe` is in flight is not followed: its `unsubscribed` ack will come
    // first (the hub handles requests in order), and this `subscribe` then follows it again.
    const following = this.#accepted.has(team) && !this.#leaving.has(team);
    if (following || this.#subscribing(team)) return;
    if (this.#asked?.has(team) === true && !this.#leaving.has(team)) return;
    this.#subscribe([team]);
  }

  /** A `subscribe` naming `team` is sent and not yet acked. */
  #subscribing(team: string): boolean {
    return this.#sent.some((teams) => teams.includes(team));
  }

  #subscribe(teams: readonly string[]): void {
    if (teams.length === 0) return;
    if (this.#host.send({ t: 'subscribe', teams: [...teams] })) this.#sent.push(teams);
  }

  #leave(team: string): void {
    const followed =
      this.#accepted.has(team) ||
      this.#asked?.has(team) === true ||
      this.#sent.some((teams) => teams.includes(team));
    if (followed && !this.#leaving.has(team)) {
      if (this.#host.send({ t: 'unsubscribe', teams: [team] })) {
        this.#leaving.add(team);
        return;
      }
    }
    if (this.#leaving.has(team)) return;
    // Not followed on this connection, or the socket is down: the next one won't name it, and
    // its rows go now if no packet of it can still arrive.
    if (!followed) this.#remove([team]);
  }

  async #hold(team: string): Promise<void> {
    if (this.#held.has(team) || this.#holding.has(team)) return;
    const locks = this.#host.locks();
    if (locks === undefined) {
      runInAction(() => this.#held.add(team));
      return;
    }
    this.#holding.add(team);
    const lifetime = this.#lifetime;
    try {
      const release = await holdShared(
        locks,
        teamLockName(this.#host.replica, team),
        this.#lockAbort.signal,
      );
      if (lifetime !== this.#lifetime || !this.wanted.has(team)) {
        void release();
        return;
      }
      this.#holds.set(team, release);
      runInAction(() => this.#held.add(team));
    } catch {
      // No lock (the store closed meanwhile): the team waits for the next start.
    } finally {
      this.#holding.delete(team);
    }
  }

  /** Let go of the team's shared lock; resolves once it is released. */
  #release(team: string): Promise<void> {
    const release = this.#holds.get(team);
    this.#holds.delete(team);
    runInAction(() => this.#held.delete(team));
    return release?.() ?? Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Socket messages, in order with the deltas

  onAck(message: SubscribedMessage | UnsubscribedMessage): void {
    if (!this.#prepared.get()) return;
    if (message.t === 'subscribed') this.#subscribed(message);
    else this.#unsubscribed(message);
  }

  #subscribed(message: SubscribedMessage): void {
    // The first message of a connection that named `teams` is its `subscribed` (§4.3).
    const atConnect = this.#asked !== undefined;
    const asked = atConnect ? (this.#asked ?? new Set<string>()) : new Set(this.#sent.shift());
    const accepted = new Set(message.teams);
    if (atConnect) this.#asked = undefined;
    const load: string[] = [];
    runInAction(() => {
      for (const team of accepted) {
        this.#accepted.add(team);
        this.#refused.delete(team);
      }
      for (const team of asked) if (!accepted.has(team)) this.#refused.add(team);
    });
    for (const team of accepted) {
      if (!this.wanted.has(team)) {
        this.#leave(team);
        continue;
      }
      if (!this.#current.has(team) && !this.#loading.has(team)) load.push(team);
    }
    if (atConnect) {
      // Teams this tab followed before and no longer names: no packet of them comes.
      const gone = [...new Set([...this.#loaded, ...this.#current])].filter(
        (team) => !asked.has(team) && !this.wanted.has(team),
      );
      if (gone.length > 0) this.#remove(gone);
      // Wanted teams the URL couldn't name yet (their lock arrived while dialling).
      const missing = [...this.wanted].filter(
        (t) => this.#held.has(t) && !asked.has(t) && !this.#subscribing(t),
      );
      this.#subscribe(missing.slice(0, MAX_TEAMS_PER_MESSAGE));
    }
    // A refused team is invisible now: rows it left would never be kept live.
    const refused = [...asked].filter((t) => !accepted.has(t) && this.#loaded.has(t));
    if (refused.length > 0) this.#remove(refused);
    if (load.length > 0) this.#load(load, 0);
  }

  #unsubscribed(message: UnsubscribedMessage): void {
    const remove: string[] = [];
    for (const team of message.teams) {
      this.#leaving.delete(team);
      runInAction(() => this.#accepted.delete(team));
      this.#current.delete(team);
      this.#doneLoading(team);
      // Wanted again: its `subscribe` follows (sent by `#follow`), and its ack loads it afresh.
      if (!this.wanted.has(team)) remove.push(team);
    }
    if (remove.length > 0) this.#remove(remove);
    // Wanted again with no `subscribe` on its way (the lock came back meanwhile): send one now.
    const again = message.teams.filter(
      (team) => this.wanted.has(team) && this.#held.has(team) && !this.#subscribing(team),
    );
    this.#subscribe(again.slice(0, MAX_TEAMS_PER_MESSAGE));
  }

  /** After a delta batch was applied: remember what it changed while a load is pending. */
  afterDeltas(plan: Extract<DeltaPlan, { kind: 'apply' }>): void {
    if (this.#loading.size === 0) return;
    for (const row of plan.touched) this.#touched.set(key(row.model, row.id), row.version);
  }

  // ---------------------------------------------------------------------------
  // Partial bootstrap

  #load(teams: readonly string[], attempt: number): void {
    runInAction(() => {
      for (const team of teams) this.#loading.set(team, attempt);
    });
    const epoch = this.#epoch;
    this.#host.fetchPartial(teams, this.#abort.signal).then(
      (answer) => {
        if (epoch === this.#epoch) this.#applyAnswer(teams, answer);
      },
      (error: unknown) => {
        if (epoch !== this.#epoch) return;
        if (error instanceof ClientOutdatedError) {
          this.#host.outdated();
          return;
        }
        this.#scheduleRetry();
      },
    );
  }

  #scheduleRetry(): void {
    if (this.#retry !== undefined) return;
    const delay = backoffDelay(this.#retryAttempt, this.#host.random());
    this.#retryAttempt += 1;
    const epoch = this.#epoch;
    this.#retry = this.#host.timers.setTimeout(() => {
      this.#retry = undefined;
      if (epoch !== this.#epoch) return;
      const teams = [...this.#loading.keys()].filter((team) => this.#accepted.has(team));
      for (const team of [...this.#loading.keys()]) {
        if (!teams.includes(team)) this.#doneLoading(team);
      }
      if (teams.length > 0) this.#load(teams, this.#retryAttempt);
    }, delay);
  }

  /**
   * Apply an answer (SPEC-011 §5.7 `writePartialRows`, E30, E35). The pool takes each row no
   * packet above `C` changed, and drops the teams' rows absent from the answer that no packet
   * above `C` changed (the sweep); storage applies the same rule by row version.
   */
  #applyAnswer(teams: readonly string[], answer: PartialAnswer): void {
    const { rules } = this.#host;
    const still = teams.filter((team) => this.#loading.has(team) && this.#accepted.has(team));
    for (const team of teams) this.#doneLoading(team);
    this.#retryAttempt = 0;
    const applied = this.#host.appliedId();
    if (still.length > 0 && applied !== undefined) {
      const C = answer.lastSyncId;
      const newer = (model: string, id: string) => (this.#touched.get(key(model, id)) ?? -1) > C;
      const teamSet = new Set(still);
      const issues = new Set(
        answer.rows
          .filter((r) => r.model === rules.issue && teamSet.has(teamOf(r.row) ?? ''))
          .map((r) => r.row.id),
      );
      const parentOf = new Map(rules.children.map((c) => [c.model, c.field]));
      const rows = answer.rows.filter((r) =>
        r.model === rules.issue
          ? issues.has(r.row.id)
          : issues.has(String(r.row[parentOf.get(r.model) ?? ''])),
      );
      const changes: BaseChange[] = [];
      const answered = new Set(rows.map((r) => key(r.model, r.row.id)));
      const pool = this.#host.pool;
      // A child goes in only with its issue: one a later packet removed (a purge's lone `D`,
      // whose children's deletes are not logged) takes the answer's children with it.
      const issueStays = (id: string) =>
        newer(rules.issue, id) ? pool.baseOf(rules.issue, id) !== undefined : issues.has(id);
      for (const { model, row, archived } of rows) {
        if (newer(model, row.id)) continue;
        if (model !== rules.issue && !issueStays(String(row[parentOf.get(model) ?? '']))) continue;
        changes.push({ kind: archived ? 'archive' : 'unarchive', model, row });
      }
      const swept = new Set<string>();
      for (const { row } of pool.baseRows(rules.issue)) {
        if (!teamSet.has(teamOf(row) ?? '') || issues.has(row.id) || newer(rules.issue, row.id)) {
          continue;
        }
        swept.add(row.id);
        changes.push({ kind: 'delete', model: rules.issue, id: row.id });
      }
      const parents = new Set([...issues, ...swept]);
      for (const child of rules.shape.children) {
        for (const { row } of pool.baseRows(child.model)) {
          if (!parents.has(String(row[child.field]))) continue;
          if (answered.has(key(child.model, row.id)) || newer(child.model, row.id)) continue;
          changes.push({ kind: 'delete', model: child.model, id: row.id });
        }
      }
      // TODO(PLAN-011 S5b): drop the hydration marks of the swept issues with their content.
      for (const content of rules.shape.content) {
        for (const { row } of pool.baseRows(content.model)) {
          if (swept.has(String(row[content.field])) && !newer(content.model, row.id)) {
            changes.push({ kind: 'delete', model: content.model, id: row.id });
          }
        }
      }
      this.#host.applyBase(changes);
      const persistence = this.#host.persistence();
      const generation = this.#host.generation();
      if (persistence !== undefined && generation !== undefined) {
        const write = { shape: rules.shape, teams: still, rows, version: C, through: applied };
        this.#host.enqueue(() =>
          persistence.writeReplica(generation, (storage) =>
            storage.writePartialRows(generation, write),
          ),
        );
      }
      for (const team of still) this.#current.add(team);
      runInAction(() => {
        for (const team of still) this.#loaded.add(team);
      });
    }
    if (this.#loading.size === 0) this.#touched.clear();
  }

  #doneLoading(team: string): void {
    runInAction(() => this.#loading.delete(team));
  }

  #cancelLoads(): void {
    this.#epoch += 1;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#host.timers.clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#retryAttempt = 0;
    runInAction(() => this.#loading.clear());
    this.#touched.clear();
  }

  // ---------------------------------------------------------------------------
  // Removal

  /** The teams whose rows this tab keeps: home teams and the wanted ones the server accepts. */
  #followed(): Set<string> {
    const { privateTeams } = this.#membership.get();
    const wanted = [...this.wanted].filter((team) => !this.#refused.has(team));
    return new Set([...privateTeams, ...wanted]);
  }

  /** The groups that keep an Issue row in this tab: its connection's, after any leave. */
  #keepGroups(): Set<string> {
    const teams = [...this.#followed()].map((team) => `team:${team}`);
    return new Set(['workspace', `user:${this.#host.userId}`, ...teams]);
  }

  /**
   * Remove teams this tab no longer follows (SPEC-011 §5.7, E31, E36): from the pool, the Issue
   * rows no connection group keeps, and the children and content of every issue of a team it
   * doesn't follow; from storage, the same under the exclusive team lock.
   */
  #remove(teams: readonly string[]): void {
    runInAction(() => {
      for (const team of teams) {
        this.#loaded.delete(team);
        this.#accepted.delete(team);
      }
    });
    const released = new Map<string, Promise<void>>();
    for (const team of teams) {
      this.#current.delete(team);
      this.#doneLoading(team);
      released.set(team, this.#release(team));
    }
    this.#prune();
    const persistence = this.#host.persistence();
    const generation = this.#host.generation();
    if (persistence === undefined || generation === undefined) return;
    const keep = [...this.#keepGroups()];
    const remove = (team: string) => {
      const removal = { shape: this.#host.rules.shape, teams: [team], keep };
      return persistence.writeReplica(generation, (storage) =>
        storage.removeTeamRows(generation, removal),
      );
    };
    if (!this.#host.sharedStorage()) {
      for (const team of teams) this.#host.enqueue(() => remove(team));
      return;
    }
    const locks = this.#host.locks();
    // Without Web Locks another tab may follow the team unseen: never remove (§5.7).
    if (locks === undefined) return;
    for (const team of teams) {
      // After this tab's own shared hold is let go, or it would find itself holding the lock.
      const exclusive = (released.get(team) ?? Promise.resolve()).then(() =>
        tryHold(locks, teamLockName(this.#host.replica, team)),
      );
      void exclusive.then((release) => {
        // Another tab follows the team (E36), or this tab wants it again: its rows stay.
        if (release === undefined) return;
        if (this.wanted.has(team)) {
          release();
          return;
        }
        this.#host.enqueue(() => remove(team).finally(release));
      });
    }
  }

  /**
   * Drop from the pool what this tab doesn't keep live: Issue rows none of its groups keeps,
   * and the eager children and content of issues of teams it doesn't follow (an issue held
   * through `user:` gets no child rows, SPEC-011 §5.7). Storage is left alone.
   */
  #prune(): void {
    const { rules, pool } = this.#host;
    const followed = this.#followed();
    const keep = this.#keepGroups();
    const changes: BaseChange[] = [];
    const live = new Set<string>();
    for (const { row } of pool.baseRows(rules.issue)) {
      if (!meetsGroups(row, keep) || isRemovedIssue(row)) {
        changes.push({ kind: 'delete', model: rules.issue, id: row.id });
      } else if (followed.has(teamOf(row) ?? '')) {
        live.add(row.id);
      }
    }
    // TODO(PLAN-011 S5b): drop the hydration marks of these issues with their content.
    for (const child of [...rules.shape.children, ...rules.shape.content]) {
      for (const { row } of pool.baseRows(child.model)) {
        if (!live.has(String(row[child.field]))) {
          changes.push({ kind: 'delete', model: child.model, id: row.id });
        }
      }
    }
    if (changes.length > 0) this.#host.applyBase(changes);
  }

  #readMembership(): Membership {
    const { pool, rules, userId } = this.#host;
    const publicTeams = new Set<string>();
    const privateTeams = new Set<string>();
    for (const membership of pool.all(rules.membership)) {
      if (membership['userId'] !== userId) continue;
      const teamId = membership['teamId'];
      if (typeof teamId !== 'string') continue;
      const team = pool.get(rules.team, teamId);
      if (team === undefined) continue;
      (team['private'] === true ? privateTeams : publicTeams).add(teamId);
    }
    return { publicTeams, privateTeams };
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
