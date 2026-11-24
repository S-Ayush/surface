// The archive page's data (SPEC-015 §3.3, D17, AC-19, E23, E24; PLAN-015 S4). The replica holds no
// archived or deleted issue (SPEC-011 §5.7), so both tabs read the server:
//
// - Issues: `issue.list {team, includeArchived: true, filter: archivedAt is set, orderBy:
//   archivedAt desc}`;
// - Recently deleted issues: `issue.listDeleted {team}`, which leaves out issues past `purgeAfter`.
//
// Pages of 50 as the list scrolls. It refreshes on window focus, after the user's own delete,
// restore and purge confirmations (`lifecycle-events.ts`), when the connection comes back, and,
// only while the team is subscribed, on its packets (`archive-packets.ts`, at most once a second).
// Offline, or once the connection drops, it shows "Available when online": restore needs the
// network here (§3.3 item 7). Opening the page never subscribes the team: nothing here calls
// `openTeam`. A restore takes its row off the list at once. Pure of React: the screen adapts it
// with `useArchiveSource`.
import type { Filter } from '@surface/domain';
import type { OperationAnswer } from '../files/operation.js';
import type { ArchivedIssue } from '../issues/list-model.js';
import { watchArchivePackets, type PacketWatchDeps } from './archive-packets.js';
import type { LifecycleEvent, LifecycleEvents } from './lifecycle-events.js';

export { PACKET_REFRESH_MS, type ArchivePacket } from './archive-packets.js';

export type ArchiveTab = 'archived' | 'deleted';

/** Rows per request (§3.3 item 4). */
export const ARCHIVE_PAGE_SIZE = 50;

/** The Issues tab's query: the team's archived issues, newest archived first. */
export const ARCHIVED_FILTER: Filter = { field: 'archivedAt', op: 'exists', value: true };

/** One page as both queries answer it. */
export interface ArchivePage {
  readonly nodes: readonly ArchivedIssue[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}

export interface ArchiveSourceDeps extends PacketWatchDeps {
  /** One page of `tab` for `teamKey`, after `cursor`. */
  fetchPage(
    tab: ArchiveTab,
    teamKey: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<OperationAnswer<ArchivePage>>;
  /** Whether the store's connection is up. */
  online(): boolean;
  /** Calls back each time the connection comes up (`true`) or goes down (`false`). */
  watchConnection(listener: (online: boolean) => void): () => void;
  /** Calls back on each window focus. */
  watchFocus(listener: () => void): () => void;
  readonly events: LifecycleEvents;
}

export type ArchiveState =
  /** "Loading…" until the first page arrives. */
  | { readonly status: 'loading' }
  /** "Available when online" (E23). */
  | { readonly status: 'offline' }
  /** The server failed for a reason that isn't the connection: try again. */
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly issues: readonly ArchivedIssue[];
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
    };

const LOADING: ArchiveState = { status: 'loading' };
const OFFLINE: ArchiveState = { status: 'offline' };
const FAILED = "Couldn't load these issues. Try again in a moment.";

export class ArchiveSource {
  readonly #tab: ArchiveTab;
  readonly #team: { readonly id: string; readonly key: string };
  readonly #deps: ArchiveSourceDeps;
  #state: ArchiveState = LOADING;
  #cursor: string | null = null;
  /** Bumped by each refresh and stop, so an older answer never lands over a newer one. */
  #generation = 0;
  /** A refresh is waiting for its answer: a next page would follow an old cursor. */
  #refreshing = false;
  /** Issues whose restore was sent: off the list until it is confirmed or refused. */
  readonly #restoring = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #stops: (() => void)[] = [];

  constructor(
    tab: ArchiveTab,
    team: { readonly id: string; readonly key: string },
    deps: ArchiveSourceDeps,
  ) {
    this.#tab = tab;
    this.#team = team;
    this.#deps = deps;
  }

  /** Loads the first page and starts listening. Returns the stop function. */
  start(): () => void {
    const deps = this.#deps;
    this.#stops = [
      deps.watchFocus(() => void this.refresh()),
      deps.watchConnection((online) => {
        if (online) {
          void this.refresh();
          return;
        }
        // §3.3 item 7: restore needs the network here, so the rows go until it is back.
        this.#generation += 1;
        this.#refreshing = false;
        this.#set(OFFLINE);
      }),
      watchArchivePackets(
        deps,
        this.#team.id,
        (id) => this.#listed(id),
        () => void this.refresh(),
      ),
      deps.events.subscribe((event) => {
        this.#onEvent(event);
      }),
    ];
    void this.refresh();
    return () => {
      this.stop();
    };
  }

  stop(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    // Answers still in flight are dropped.
    this.#generation += 1;
    this.#refreshing = false;
  }

  getState = (): ArchiveState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Reads the list again from the start, as many rows as it shows (at least a page). Rows shown
   * stay until the answer arrives; from offline or a failure it says "Loading…" first.
   */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    if (!this.#deps.online()) {
      this.#refreshing = false;
      this.#set(OFFLINE);
      return;
    }
    const before = this.#state;
    if (before.status === 'offline' || before.status === 'error') this.#set(LOADING);
    this.#refreshing = true;
    const wanted = Math.max(
      ARCHIVE_PAGE_SIZE,
      before.status === 'ready' ? before.issues.length : 0,
    );
    const issues: ArchivedIssue[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore && issues.length < wanted) {
      const answer = await this.#deps.fetchPage(
        this.#tab,
        this.#team.key,
        cursor,
        ARCHIVE_PAGE_SIZE,
      );
      if (generation !== this.#generation) return;
      if (!answer.ok) {
        this.#refreshing = false;
        this.#failed(answer.code);
        return;
      }
      issues.push(...answer.result.nodes);
      hasMore = answer.result.pageInfo.hasNextPage;
      cursor = answer.result.pageInfo.endCursor ?? undefined;
      if (cursor === undefined) hasMore = false;
    }
    this.#refreshing = false;
    this.#cursor = cursor ?? null;
    this.#set({ status: 'ready', issues: this.#shown(issues), hasMore, loadingMore: false });
  }

  /** The next page, when the list scrolls near its end. Not while a refresh is on its way. */
  async loadMore(): Promise<void> {
    const state = this.#state;
    if (state.status !== 'ready' || !state.hasMore || state.loadingMore) return;
    if (this.#refreshing || this.#cursor === null || !this.#deps.online()) return;
    const generation = this.#generation;
    this.#set({ ...state, loadingMore: true });
    const answer = await this.#deps.fetchPage(
      this.#tab,
      this.#team.key,
      this.#cursor,
      ARCHIVE_PAGE_SIZE,
    );
    // A refresh, a drop or a stop since: this page follows a cursor that no longer applies.
    if (generation !== this.#generation) return;
    const current = this.#state;
    if (current.status !== 'ready') return;
    if (!answer.ok) {
      if (answer.code === 'UNREACHABLE') this.#set(OFFLINE);
      else this.#set({ ...current, loadingMore: false });
      return;
    }
    const known = new Set(current.issues.map((issue) => issue.id));
    const added = answer.result.nodes.filter((issue) => !known.has(issue.id));
    this.#cursor = answer.result.pageInfo.endCursor;
    this.#set({
      status: 'ready',
      issues: this.#shown([...current.issues, ...added]),
      hasMore: answer.result.pageInfo.hasNextPage && this.#cursor !== null,
      loadingMore: false,
    });
  }

  #listed(issueId: string): boolean {
    const state = this.#state;
    return state.status === 'ready' && state.issues.some((issue) => issue.id === issueId);
  }

  #failed(code: string): void {
    // Offline, or the server couldn't be reached: "Available when online" (E23).
    this.#set(code === 'UNREACHABLE' ? OFFLINE : { status: 'error', message: FAILED });
  }

  #shown(issues: readonly ArchivedIssue[]): ArchivedIssue[] {
    return issues.filter((issue) => !this.#restoring.has(issue.id));
  }

  #onEvent(event: LifecycleEvent): void {
    if (event.kind === 'restoring') {
      // §3.3 item 7: the restored row leaves the list at once.
      this.#restoring.add(event.issueId);
      const state = this.#state;
      if (state.status === 'ready') this.#set({ ...state, issues: this.#shown(state.issues) });
      return;
    }
    if (event.op === 'restore') this.#restoring.delete(event.issueId);
    // The user's own delete, restore or purge was confirmed or refused: read the list again.
    void this.refresh();
  }

  #set(state: ArchiveState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }
}
