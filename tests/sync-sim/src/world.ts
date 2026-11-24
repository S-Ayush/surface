/**
 * A simulated deployment (PLAN-002 S9): one server, a controllable network,
 * and the tabs of a few users, each a real `SyncStore` on fake-indexeddb.
 * Tabs of one user share a replica and a Web Locks manager, like tabs of one
 * browser profile. Timers run on Vitest's fake clock and storage between
 * timers (`clock.ts`), and randomness is seeded (`random.ts`), so a case
 * replays exactly from its seed.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  Attachment,
  Comment,
  DebugItem,
  Draft,
  Issue,
  IssueContent,
  IssueHistory,
  Reaction,
} from '@surface/domain/model';
import type { AnyOperation, InputOf } from '@surface/operations';
import type { MutationOutcome, StorageConnector } from '@surface/sync-client';
import { ContentUnavailableError, SyncStore } from '@surface/sync-client';
import type { QueueWrite, SyncStorage } from '@surface/sync-client/testing';
import { IndexedDbStorage } from '@surface/sync-client/testing';
import { advance, settle } from './clock.js';
import { BrowserLocks } from './locks.js';
import type { Link } from './network.js';
import { Network } from './network.js';
import type { Random } from './random.js';
import { seededRandom, uuidFrom } from './random.js';
import type {
  AttachmentState,
  CommentState,
  DraftState,
  IssueContentState,
  IssueHistoryState,
  IssueState,
  ItemState,
  ReactionState,
  SimServer,
} from './server.js';
import { TabTimers } from './timers.js';

export interface WorldOptions {
  readonly seed: number;
  /** Web Locks (secure origin) or none (plain HTTP: queues move by lease, E5). */
  readonly webLocks: boolean;
}

export interface User {
  /** The server's id for the user. */
  readonly id: string;
  /** `user-1`, `user-2`, … in failure messages, whatever the server's ids. */
  readonly name: string;
  readonly locks: BrowserLocks;
}

export interface Tab {
  readonly name: string;
  readonly user: User;
  readonly store: SyncStore;
  readonly link: Link;
  readonly timers: TabTimers;
  readonly alive: boolean;
}

interface TabState {
  alive: boolean;
  readonly storages: SyncStorage[];
  /** Storage calls made so far. */
  calls: number;
  /** Crash as this storage call starts (`crashAfterStorageCalls`). */
  crashAtCall?: number;
}

/** One `dispatch` the store accepted. */
export interface Dispatched {
  readonly tab: string;
  readonly op: string;
  readonly input: unknown;
  /** `clientId:seq`, the key it is saved and sent under. */
  readonly key: string;
  outcome?: MutationOutcome;
}

/** A mutation whose save to IndexedDB completed. */
export interface Saved {
  readonly op: string;
  readonly input: unknown;
}

/** The app's "Try again" after a failed first start (SPEC-002 §7). */
const START_RETRY_MS = 2_000;
/** Virtual time between checks while waiting for quiescence. */
const SETTLE_STEP_MS = 50;

export class World {
  readonly random: Random;
  readonly server: SimServer;
  readonly network: Network;
  readonly users: readonly User[];
  readonly tabs: Tab[] = [];
  readonly dispatched: Dispatched[] = [];
  /**
   * Every mutation saved to a replica, by `clientId:seq`. A dispatch counts
   * from here on: a crash before the save may lose it (SPEC-002 §3.3), a
   * crash after must not.
   */
  readonly saved = new Map<string, Saved>();
  /** Ids of the issues `issueCreate` steps dispatched, accepted or not (PLAN-011 S4). */
  readonly issueIds: string[] = [];
  /** Ids of every comment a step created (PLAN-013 S3), refused ones included. */
  readonly commentIds: string[] = [];
  /** Ids of every attachment a step created (PLAN-014 S4a), refused ones included. */
  readonly attachmentIds: string[] = [];
  readonly #problems: string[] = [];
  readonly #webLocks: boolean;
  readonly #states = new Map<Tab, TabState>();
  /** Faults have stopped: from here, a failed start is a bug. */
  #healed = false;

  /** One user per user of `server`. */
  constructor(options: WorldOptions, server: SimServer) {
    this.random = seededRandom(options.seed);
    this.server = server;
    this.network = new Network(server, this.random);
    this.#webLocks = options.webLocks;
    // Each world gets empty browsers: a fresh IndexedDB, so replica names
    // never collide and do not depend on which case ran before.
    globalThis.indexedDB = new IDBFactory();
    this.users = server.users.map((id, i) => ({
      id,
      name: `user-${i + 1}`,
      locks: new BrowserLocks(),
    }));
  }

  get live(): Tab[] {
    return this.tabs.filter((tab) => tab.alive);
  }

  /**
   * What went wrong that should not have: callbacks the app treats as errors,
   * a start that failed once the network was healthy, a store error on a
   * live tab, and anything the server reports.
   */
  get problems(): string[] {
    const errors = this.live
      .filter(({ store }) => store.error !== undefined)
      .map(({ name, store }) => `${name}: store error "${String(store.error)}"`);
    const server = this.server.problems.map((problem) => `server: ${problem}`);
    return [...this.#problems, ...errors, ...server];
  }

  /** Open a new tab for `user` and start its store; `fresh`: on an empty replica of its own. */
  open(user: User, options: { readonly fresh?: boolean } = {}): Tab {
    const name = `${user.name}/${options.fresh ? 'fresh' : 'tab'}-${this.tabs.length + 1}`;
    const link = this.network.link(user.id);
    const timers = new TabTimers();
    const locks = this.#webLocks ? user.locks.forTab(name) : null;
    const state: TabState = { alive: true, storages: [], calls: 0 };
    const hooks: StorageHooks = {
      alive: () => state.alive,
      beforeCall: () => {
        state.calls += 1;
        if (state.crashAtCall !== undefined && state.calls >= state.crashAtCall) this.crash(tab);
      },
      saved: (write) => {
        for (const record of write.put ?? []) {
          this.saved.set(`${record.clientId}:${record.seq}`, {
            op: record.op,
            input: record.input,
          });
        }
      },
    };
    const connectStorage: StorageConnector = async (replica, models, content) => {
      const storage = await IndexedDbStorage.open(replica, models, content);
      state.storages.push(storage);
      return instrumented(storage, hooks);
    };
    const store = new SyncStore({
      models: this.server.models,
      // A fresh tab gets a replica of its own, which starts empty: it bootstraps from the
      // server, so it shows what a cold start would (PLAN-011 S2's archive property).
      workspaceId: options.fresh ? `sim-${name}` : 'sim',
      userId: user.id,
      fetch: link.fetch,
      baseUrl: 'http://surface.test',
      connectStorage,
      locks,
      // Seeded, so queue ids (which order adoption, E5) replay exactly.
      clientId: uuidFrom(this.random),
      connection: {
        socket: link.socket,
        timers,
        random: this.random,
        online: link.onlineSource,
      },
      clock: () => Date.now(),
      onRejected: () => undefined,
      onOutdated: () => this.#problems.push(`${name}: told to reload (CLIENT_OUTDATED)`),
      onSessionRevoked: () => this.#problems.push(`${name}: session revoked`),
    });
    const tab: Tab = {
      name,
      user,
      store,
      link,
      timers,
      get alive() {
        return state.alive;
      },
    };
    this.#states.set(tab, state);
    this.tabs.push(tab);
    this.#start(tab);
    return tab;
  }

  #start(tab: Tab): void {
    const healthy = this.#healed;
    tab.store.start().catch((error: unknown) => {
      if (!tab.alive) return;
      if (healthy) this.#problems.push(`${tab.name}: start failed: ${String(error)}`);
      // A first start needs the server; the app offers to try again.
      tab.timers.setTimeout(() => this.#start(tab), START_RETRY_MS);
    });
  }

  /**
   * The tab is gone at once, mid-whatever: its timers, network and locks die
   * with it. Its store is never closed, as in a real crash; what it already
   * wrote to IndexedDB stays.
   */
  crash(tab: Tab): void {
    const state = this.#states.get(tab);
    if (state === undefined || !state.alive) return;
    state.alive = false;
    tab.timers.kill();
    tab.link.kill();
    if (this.#webLocks) tab.user.locks.forTab(tab.name).kill();
    // The browser closes a dead tab's database connections.
    for (const storage of state.storages) storage.close().catch(() => undefined);
  }

  /**
   * Crash the tab as it starts its `calls`-th storage call from now: between
   * two IndexedDB transactions of one event, or before a mutation is saved.
   */
  crashAfterStorageCalls(tab: Tab, calls: number): void {
    const state = this.#states.get(tab);
    if (state?.alive) state.crashAtCall = state.calls + calls;
  }

  /** A reload: the tab crashes and a new one opens for the same user. */
  reload(tab: Tab): Tab | undefined {
    if (!tab.alive) return undefined;
    this.crash(tab);
    return this.open(tab.user);
  }

  /**
   * Dispatch on a live tab. Returns false when the store refuses it (not
   * loaded yet, or stopped), as the UI would show an error and do nothing.
   */
  dispatch<Op extends AnyOperation>(tab: Tab, op: Op, input: InputOf<Op>): boolean {
    if (!tab.alive) return false;
    let outcome: Promise<MutationOutcome>;
    // A content mutation may wait for its issue's content before it is queued (SPEC-011 §5.3
    // step 6, PLAN-011 S5b): it counts from its seq on.
    let record: Dispatched | undefined;
    const onQueued = ({ clientId, seq }: { clientId: string; seq: number }) => {
      record = { tab: tab.name, op: op.name, input, key: `${clientId}:${String(seq)}` };
      this.dispatched.push(record);
    };
    try {
      outcome = tab.store.dispatch(op, input, { onQueued });
    } catch {
      return false;
    }
    outcome.then(
      (result) => {
        if (record !== undefined) record.outcome = result;
      },
      (error: unknown) => {
        // Refused before it was queued, as a synchronous throw is, only offline on an issue never
        // loaded ("Available when online", E11). Any other refusal is a problem.
        const offline = tab.store.connection === 'offline';
        if (record === undefined && offline && error instanceof ContentUnavailableError) return;
        const when = record === undefined ? 'before it was queued' : record.key;
        this.#problems.push(`${tab.name}: dispatch failed (${when}): ${String(error)}`);
      },
    );
    return true;
  }

  // Per-issue content (SPEC-011 §5.4, PLAN-011 S5b): a tab holds an issue's comments only while
  // the issue is open in it, as the issue page keeps it.

  readonly #showing = new Map<Tab, Set<string>>();

  /** The tab shows these issues (their pages are open): their content is paged in and kept live. */
  showIssues(tab: Tab, issueIds: readonly string[]): void {
    let open = this.#showing.get(tab);
    if (open === undefined) this.#showing.set(tab, (open = new Set()));
    for (const issueId of issueIds) {
      if (open.has(issueId)) continue;
      open.add(issueId);
      tab.store.content.open(issueId);
    }
  }

  /** Every live tab shows these issues: run until each has their content (or none to load). */
  async showEverywhere(issueIds: readonly string[], limitMs = 60_000): Promise<void> {
    for (const tab of this.live) this.showIssues(tab, issueIds);
    for (let waited = 0; ; waited += SETTLE_STEP_MS) {
      const shown = this.live.every((tab) =>
        issueIds.every((issueId) => tab.store.content.state(issueId) === 'ready'),
      );
      if (shown) return;
      if (waited >= limitMs) {
        throw new Error(`Issue content not loaded after ${limitMs} ms: ${await this.describe()}`);
      }
      await this.run(SETTLE_STEP_MS);
    }
  }

  /** Let `ms` of virtual time pass (storage work in between takes none). */
  run(ms: number): Promise<void> {
    return advance(ms);
  }

  /** Run until every live tab has loaded (first starts need the server). */
  async loaded(limitMs = 60_000): Promise<void> {
    for (let waited = 0; ; waited += SETTLE_STEP_MS) {
      if (this.live.every(({ store }) => store.status === 'ready')) return;
      if (waited >= limitMs) {
        throw new Error(`Tabs not loaded after ${limitMs} ms: ${await this.describe()}`);
      }
      await this.run(SETTLE_STEP_MS);
    }
  }

  /**
   * Stop every fault and run until no request is on its way to the server,
   * each live tab is loaded, online, has nothing pending and has caught up,
   * and no replica holds work for a tab that is gone; fail after `limitMs` of
   * virtual time.
   */
  async quiesce(limitMs = 10 * 60_000): Promise<void> {
    this.network.heal();
    this.#healed = true;
    for (const state of this.#states.values()) state.crashAtCall = undefined;
    for (let waited = 0; ; waited += SETTLE_STEP_MS) {
      if (await this.#settled()) {
        const stranded = await this.#strandedWork();
        if (stranded.length === 0) return;
        // With Web Locks, a queue left by a crashed tab waits for the next tab
        // to start (SPEC-002 E5): the user opens one. Without them, an open
        // tab must adopt it on a lease renewal, so the harness waits.
        if (this.#webLocks) for (const user of stranded) this.open(user);
      }
      if (waited >= limitMs) {
        throw new Error(`Not quiescent after ${limitMs} ms: ${await this.describe()}`);
      }
      await this.run(SETTLE_STEP_MS);
    }
  }

  /**
   * Open one more tab per user and settle again. The new tab warm-starts from
   * what the replica saved, so comparing it checks the persisted state, not
   * only what the open tabs hold in memory.
   */
  async reopenEveryUser(): Promise<void> {
    for (const user of this.users) this.open(user);
    await this.quiesce();
  }

  async #settled(): Promise<boolean> {
    // A request still on its way (one a crashed tab gave up on, say) could
    // run on the server after the check: wait for it.
    if (this.network.requestsInFlight > 0) return false;
    const head = await this.server.head();
    const heads = new Map<string, number>();
    for (const { user } of this.live) {
      if (!heads.has(user.id)) heads.set(user.id, await this.server.headFor(user.id));
    }
    // A tab never receives another user's drafts (PLAN-012 S5), so it is caught up once it holds
    // everything its user can see, whether or not the hub has moved it past the rest.
    return this.live.every(({ store, user }) => {
      const at = store.position?.lastSyncId;
      return (
        store.status === 'ready' &&
        store.connection === 'online' &&
        store.pending.length === 0 &&
        at !== undefined &&
        at >= (heads.get(user.id) ?? head) &&
        at <= head
      );
    });
  }

  /**
   * Users whose replica still holds pending mutations in a queue no open tab
   * owns (left by a crashed tab), read straight from IndexedDB.
   */
  async #strandedWork(): Promise<User[]> {
    const stranded: User[] = [];
    for (const user of this.users) {
      const tabs = this.live.filter((tab) => tab.user === user);
      const storage = tabs
        .map((tab) => this.#states.get(tab)?.storages.at(-1))
        .find((s) => s !== undefined);
      if (storage === undefined) continue;
      const owned = new Set(tabs.map((tab) => tab.store.clientId));
      const read = storage.readQueue();
      await settle();
      const queue = await read;
      if (queue.pending.some((record) => !owned.has(record.clientId))) stranded.push(user);
    }
    return stranded;
  }

  /** What each live tab shows, by id: base plus overlay. */
  view(tab: Tab): Record<string, ItemState> {
    const entries = tab.store.pool.all(DebugItem).map((item): [string, ItemState] => [
      item.id,
      {
        title: item.title,
        counter: item.counter,
        groups: item.groups,
        archivedAt: item.archivedAt,
        archived: item.$archived,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The reactions a live tab holds, by id: base plus overlay (PLAN-013 S4). */
  reactionView(tab: Tab): Record<string, ReactionState> {
    const entries = tab.store.pool.all(Reaction).map((r): [string, ReactionState] => [
      r.id,
      {
        issueId: r.issueId,
        teamId: r.teamId,
        commentId: r.commentId,
        userId: r.userId,
        emoji: r.emoji,
        createdAt: r.createdAt,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The attachments a live tab holds, by id: base plus overlay (PLAN-014 S4a). */
  attachmentView(tab: Tab): Record<string, AttachmentState> {
    const entries = tab.store.pool.all(Attachment).map((a): [string, AttachmentState] => [
      a.id,
      {
        issueId: a.issueId,
        teamId: a.teamId,
        kind: a.kind,
        title: a.title,
        url: a.url,
        fileId: a.fileId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
        imageWidth: a.imageWidth,
        imageHeight: a.imageHeight,
        previewFileId: a.previewFileId,
        creatorId: a.creatorId,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The comments a live tab holds, by id: base plus overlay (PLAN-013 S3). */
  commentView(tab: Tab): Record<string, CommentState> {
    const entries = tab.store.pool.all(Comment).map((c): [string, CommentState] => [
      c.id,
      {
        issueId: c.issueId,
        teamId: c.teamId,
        parentCommentId: c.parentCommentId,
        userId: c.userId,
        actorKind: c.actorKind,
        body: c.body,
        version: c.version,
        editedAt: c.editedAt,
        deletedAt: c.deletedAt,
        resolvedAt: c.resolvedAt,
        resolvedById: c.resolvedById,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The descriptions a live tab holds, by id: base plus overlay (PLAN-011 S6). */
  descriptionView(tab: Tab): Record<string, IssueContentState> {
    const entries = tab.store.pool
      .all(IssueContent)
      .map((c): [string, IssueContentState] => [
        c.id,
        { issueId: c.issueId, teamId: c.teamId, description: c.description, version: c.version },
      ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The history entries a live tab holds, by id (PLAN-011 S6). */
  historyView(tab: Tab): Record<string, IssueHistoryState> {
    const entries = tab.store.pool.all(IssueHistory).map((h): [string, IssueHistoryState] => [
      h.id,
      {
        issueId: h.issueId,
        teamId: h.teamId,
        actorKind: h.actorKind,
        actorId: h.actorId,
        apiKeyId: h.apiKeyId,
        kind: h.kind,
        changes: h.changes,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The issues a live tab shows, by id: base plus overlay (PLAN-011 S4). */
  issueView(tab: Tab): Record<string, IssueState> {
    const entries = tab.store.pool.all(Issue).map((issue): [string, IssueState] => [
      issue.id,
      {
        teamId: issue.teamId,
        number: issue.number,
        title: issue.title,
        statusId: issue.statusId,
        priority: issue.priority,
        labelIds: [...issue.labelIds],
        sortOrder: issue.sortOrder,
        groups: issue.groups,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The drafts a tab shows (PLAN-012 S5), by id, in the shape `IssueServer.drafts` gives. */
  draftView(tab: Tab): Record<string, DraftState> {
    const entries = tab.store.pool.all(Draft).map((draft): [string, DraftState] => [
      draft.id,
      {
        userId: draft.userId,
        kind: draft.kind,
        teamId: draft.teamId,
        issueId: draft.issueId,
        data: draft.data,
      },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  /** One line per live tab, for failure messages. */
  async describe(): Promise<string> {
    const head = await this.server.head();
    const requests = `${this.network.requestsInFlight} requests in flight`;
    const tabs = this.live.map(
      ({ name, store }) =>
        `${name}: ${store.status}/${store.connection}, at ${String(store.position?.lastSyncId)} of ${head}, ${store.pending.length} pending${store.error === undefined ? '' : `, error "${store.error}"`}`,
    );
    return [requests, ...tabs].join('; ');
  }

  /** Stop everything, the server too; the caller resets the clock. */
  async dispose(): Promise<void> {
    for (const tab of this.live) this.crash(tab);
    await this.server.dispose();
  }
}

interface StorageHooks {
  alive(): boolean;
  /** Called as each storage call starts; may crash the tab. */
  beforeCall(): void;
  /** A queue write committed. */
  saved(write: QueueWrite): void;
}

/**
 * The tab's storage, as the store sees it. Two things a real browser does
 * and this process would not on its own:
 * - A crashed tab runs no more code, but its store object lives on here and
 *   its pending promises still resolve. From the crash on, every storage call
 *   it starts hangs, so it can neither write the replica nor take a queue
 *   behind the next tab's back. Transactions already running finish, as in
 *   the browser (IndexedDB commits are atomic).
 * - Each call may be where the tab crashes (`crashAfterStorageCalls`).
 * It also reports committed queue writes, so the checks know what was saved.
 */
function instrumented(storage: SyncStorage, hooks: StorageHooks): SyncStorage {
  const hang = () => new Promise<never>(() => undefined);
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'writeQueue') {
        return (write: QueueWrite): Promise<void> => {
          if (hooks.alive()) hooks.beforeCall();
          if (!hooks.alive()) return hang();
          const done = target.writeQueue(write);
          done.then(
            () => hooks.saved(write),
            () => undefined,
          );
          return done;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (hooks.alive()) hooks.beforeCall();
        return hooks.alive() ? Reflect.apply(value, target, args) : hang();
      };
    },
  });
}
