// The archive page's data (SPEC-015 §3.3, D17, AC-19, E23, E24; PLAN-015 S4). The replica holds no
// archived or deleted issue (SPEC-011 §5.7), so both tabs read the server:
//
// - Issues: `issue.list {team, includeArchived: true, filter: archivedAt is set, orderBy:
//   archivedAt desc}`;
// - Recently deleted issues: `issue.listDeleted {team}`, which leaves out issues past `purgeAfter`.
//
// Pages of 50 as the list scrolls. It refreshes on window focus, after the user's own delete,
// restore and purge confirmations (`lifecycle-events.ts`), when the connection comes back, and,
// only while the team is subscribed, on its packets: an `A`, the `U` of a delete or a restore, a
// `V`. Packet refreshes run at most once a second, because auto-archive emits many `A`s at once.
// Opening the page never subscribes the team: nothing here calls `openTeam`. A restore takes its
// row off the list at once. Pure of React: the screen adapts it with `useArchiveSource`.
import type { Filter } from '@surface/domain';
import type { OperationAnswer } from '../files/operation.js';
import type { ArchivedIssue } from '../issues/list-model.js';
import type { LifecycleEvent, LifecycleEvents } from './lifecycle-events.js';

export type ArchiveTab = 'archived' | 'deleted';

/** Rows per request (§3.3 item 4). */
export const ARCHIVE_PAGE_SIZE = 50;
/** Packet refreshes run at most this often (§3.3 item 6). */
export const PACKET_REFRESH_MS = 1_000;

/** The Issues tab's query: the team's archived issues, newest archived first. */
export const ARCHIVED_FILTER: Filter = { field: 'archivedAt', op: 'exists', value: true };

/** One page as both queries answer it. */
export interface ArchivePage {
  readonly nodes: readonly ArchivedIssue[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}

/** An applied delta packet, as the store's `recentPackets` reports it. */
export interface ArchivePacket {
  readonly id: number;
  readonly action: 'I' | 'U' | 'A' | 'V' | 'D';
  readonly model: string;
  readonly rowId: string;
}

export interface ArchiveSourceDeps {
  /** One page of `tab` for `teamKey`, after `cursor`. */
  fetchPage(
    tab: ArchiveTab,
    teamKey: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<OperationAnswer<ArchivePage>>;
  /** Whether the store's connection is up. */
  online(): boolean;
  /** Whether this tab receives the team's deltas (a member team, or one opened on demand). */
  subscribed(teamId: string): boolean;
  /** The team of an issue the replica holds now; undefined when it holds none. */
  teamOf(issueId: string): string | undefined;
  /** Calls back with packets applied from now on, oldest first. Returns the stop function. */
  watchPackets(listener: (packets: readonly ArchivePacket[]) => void): () => void;
  /** Calls back each time the connection comes back online. */
  watchOnline(listener: () => void): () => void;
  /** Calls back on each window focus. */
  watchFocus(listener: () => void): () => void;
  readonly events: LifecycleEvents;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
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
  /** Bumped by each refresh, so an older answer never lands over a newer one. */
  #generation = 0;
  #packetTimer: unknown;
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
      deps.watchOnline(() => void this.refresh()),
      deps.watchPackets((packets) => {
        this.#onPackets(packets);
      }),
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
    this.#cancelPacketTimer();
    // Answers still in flight are dropped.
    this.#generation += 1;
  }

  getState = (): ArchiveState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Reads the list again from the start, as many rows as it shows (at least a page), and keeps
   * what it shows until the answer arrives.
   */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    this.#cancelPacketTimer();
    if (!this.#deps.online()) {
      this.#set(OFFLINE);
      return;
    }
    const before = this.#state;
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
        this.#failed(answer.code);
        return;
      }
      issues.push(...answer.result.nodes);
      hasMore = answer.result.pageInfo.hasNextPage;
      cursor = answer.result.pageInfo.endCursor ?? undefined;
      if (cursor === undefined) hasMore = false;
    }
    this.#cursor = cursor ?? null;
    this.#set({ status: 'ready', issues: this.#shown(issues), hasMore, loadingMore: false });
  }

  /** The next page, when the list scrolls near its end. */
  async loadMore(): Promise<void> {
    const state = this.#state;
    if (state.status !== 'ready' || !state.hasMore || state.loadingMore) return;
    if (this.#cursor === null || !this.#deps.online()) return;
    const generation = this.#generation;
    this.#set({ ...state, loadingMore: true });
    const answer = await this.#deps.fetchPage(
      this.#tab,
      this.#team.key,
      this.#cursor,
      ARCHIVE_PAGE_SIZE,
    );
    if (generation !== this.#generation) return;
    const current = this.#state;
    if (current.status !== 'ready') return;
    if (!answer.ok) {
      this.#set({ ...current, loadingMore: false });
      if (answer.code === 'UNREACHABLE') this.#set(OFFLINE);
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

  /**
   * Packets of the team, while it is subscribed (§3.3 item 6, E24): an Issue `A` (archived), `V`
   * (restored from archive) or a `U` that removed a row from the replica (a delete) or put back
   * one this list shows (a restore). A plain edit of a live issue changes nothing here.
   */
  #onPackets(packets: readonly ArchivePacket[]): void {
    if (!this.#deps.subscribed(this.#team.id)) return;
    if (!packets.some((packet) => this.#concerns(packet))) return;
    if (this.#packetTimer !== undefined) return;
    this.#packetTimer = this.#deps.setTimeout(() => {
      this.#packetTimer = undefined;
      void this.refresh();
    }, PACKET_REFRESH_MS);
  }

  #concerns(packet: ArchivePacket): boolean {
    if (packet.model !== 'Issue') return false;
    const team = this.#deps.teamOf(packet.rowId);
    if (team !== undefined && team !== this.#team.id) return false;
    switch (packet.action) {
      case 'A':
      case 'V':
        return true;
      case 'U': {
        const state = this.#state;
        const listed = state.status === 'ready' && state.issues.some((i) => i.id === packet.rowId);
        return team === undefined || listed;
      }
      // An insert is a live issue; a `D` is a purge, which only the user's own flow or a refresh
      // shows (the purged row was never in the replica).
      case 'I':
      case 'D':
        return false;
    }
  }

  #cancelPacketTimer(): void {
    if (this.#packetTimer === undefined) return;
    this.#deps.clearTimeout(this.#packetTimer);
    this.#packetTimer = undefined;
  }

  #set(state: ArchiveState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }
}
