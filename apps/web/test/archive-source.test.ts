// PLAN-015 S4 (SPEC-015 §3.3 items 4–7, AC-19, E23, E24): the archive page's data source. Pages
// of 50, a refresh on focus, on the connection's return and after the user's own confirmations,
// a packet refresh only while the team is subscribed and at most once a second, and a restored
// row gone at once. Fakes only: no store, no network, a manual clock.
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_PAGE_SIZE,
  ArchiveSource,
  PACKET_REFRESH_MS,
  type ArchivePage,
  type ArchivePacket,
  type ArchiveSourceDeps,
  type ArchiveTab,
} from '../src/features/archive/archive-source.js';
import { LifecycleEvents } from '../src/features/archive/lifecycle-events.js';
import type { OperationAnswer } from '../src/features/files/operation.js';
import { summary, type SummaryNode } from './archive-fixtures.js';

const TEAM = { id: 'team-eng', key: 'ENG' };

type Fetch = { tab: ArchiveTab; teamKey: string; cursor: string | undefined; limit: number };

/** Deps the test drives: the server's rows, packets, focus, the connection and the clock. */
function harness(rows: SummaryNode[] = [], options: { subscribed?: boolean } = {}) {
  const fetches: Fetch[] = [];
  const state = { rows, online: true, subscribed: options.subscribed ?? true };
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  let packets: ((p: readonly ArchivePacket[]) => void) | undefined;
  let focus: (() => void) | undefined;
  let online: (() => void) | undefined;
  const held = new Map<string, string>();
  const events = new LifecycleEvents();
  const deps: ArchiveSourceDeps = {
    fetchPage: (tab, teamKey, cursor, limit): Promise<OperationAnswer<ArchivePage>> => {
      fetches.push({ tab, teamKey, cursor, limit });
      if (!state.online) {
        return Promise.resolve({ ok: false, code: 'UNREACHABLE', message: 'offline' });
      }
      const start = cursor === undefined ? 0 : Number(cursor);
      const nodes = state.rows.slice(start, start + limit);
      const end = start + nodes.length;
      const hasNextPage = end < state.rows.length;
      return Promise.resolve({
        ok: true,
        result: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null } },
      });
    },
    online: () => state.online,
    subscribed: () => state.subscribed,
    teamOf: (id) => held.get(id),
    watchPackets: (listener) => {
      packets = listener;
      return () => {
        packets = undefined;
      };
    },
    watchOnline: (listener) => {
      online = listener;
      return () => {
        online = undefined;
      };
    },
    watchFocus: (listener) => {
      focus = listener;
      return () => {
        focus = undefined;
      };
    },
    events,
    setTimeout: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const timer = timers.find((t) => t === handle);
      if (timer !== undefined) timer.cleared = true;
    },
  };
  return {
    deps,
    fetches,
    state,
    events,
    held,
    packet: (p: ArchivePacket) => packets?.([p]),
    focus: () => focus?.(),
    reconnect: () => online?.(),
    /** Runs the timers due after `ms`. */
    tick: (ms: number) => {
      for (const timer of timers.splice(0)) {
        if (!timer.cleared && timer.ms <= ms) timer.run();
        else if (!timer.cleared) timers.push(timer);
      }
    },
    pendingTimers: () => timers.filter((t) => !t.cleared).length,
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const issues = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    summary(i + 1, { archivedAt: '2026-11-10T10:00:00.000Z' }),
  );

const shown = (source: ArchiveSource) => {
  const state = source.getState();
  return state.status === 'ready' ? state.issues.map((issue) => issue.identifier) : state.status;
};

describe('ArchiveSource', () => {
  it('shows "Loading…" until the first page, then the rows (§3.3 item 5)', async () => {
    const h = harness(issues(2));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    expect(source.getState().status).toBe('loading');
    source.start();
    await flush();
    expect(shown(source)).toEqual(['ENG-1', 'ENG-2']);
    expect(h.fetches).toEqual([
      { tab: 'archived', teamKey: 'ENG', cursor: undefined, limit: ARCHIVE_PAGE_SIZE },
    ]);
  });

  it('loads pages of 50 with the cursor as the list scrolls (§3.3 item 4)', async () => {
    const h = harness(issues(120));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    expect(shown(source)).toHaveLength(50);
    await source.loadMore();
    await source.loadMore();
    expect(shown(source)).toHaveLength(120);
    expect(h.fetches.map((f) => f.cursor)).toEqual([undefined, '50', '100']);
    const state = source.getState();
    expect(state.status === 'ready' && state.hasMore).toBe(false);
  });

  it('offline, says "Available when online" and reads again when the connection returns (E23)', async () => {
    const h = harness(issues(1));
    h.state.online = false;
    const source = new ArchiveSource('deleted', TEAM, h.deps);
    source.start();
    await flush();
    expect(source.getState().status).toBe('offline');
    expect(h.fetches).toEqual([]);
    h.state.online = true;
    h.reconnect();
    await flush();
    expect(shown(source)).toEqual(['ENG-1']);
  });

  it('refreshes on window focus (§3.3 item 6)', async () => {
    const h = harness(issues(1));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    h.state.rows = issues(2);
    h.focus();
    await flush();
    expect(shown(source)).toEqual(['ENG-1', 'ENG-2']);
  });

  it("refreshes after the user's own delete and purge confirmations", async () => {
    const h = harness(issues(1));
    const source = new ArchiveSource('deleted', TEAM, h.deps);
    source.start();
    await flush();
    h.state.rows = [];
    h.events.emit({ kind: 'confirmed', op: 'purge', issueId: summary(1).id });
    await flush();
    expect(shown(source)).toEqual([]);
  });

  it('drops a restored row at once and brings it back if the restore is refused (§3.3 item 7)', async () => {
    const h = harness(issues(2));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    h.events.emit({ kind: 'restoring', issueId: summary(1).id });
    expect(shown(source)).toEqual(['ENG-2']);
    h.events.emit({ kind: 'refused', op: 'restore', issueId: summary(1).id });
    await flush();
    expect(shown(source)).toEqual(['ENG-1', 'ENG-2']);
  });

  it("refreshes on the team's A, V and restore U packets, at most once a second (E24)", async () => {
    const h = harness(issues(1));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    const before = h.fetches.length;
    // Auto-archive emits many `A`s at once: one refresh.
    for (let id = 1; id <= 20; id += 1) {
      h.packet({ id, action: 'A', model: 'Issue', rowId: `gone-${String(id)}` });
    }
    expect(h.pendingTimers()).toBe(1);
    expect(h.fetches.length).toBe(before);
    h.tick(PACKET_REFRESH_MS);
    await flush();
    expect(h.fetches.length).toBe(before + 1);
    // A restore elsewhere: the `U` of a row this list shows.
    h.packet({ id: 30, action: 'U', model: 'Issue', rowId: summary(1).id });
    h.tick(PACKET_REFRESH_MS);
    await flush();
    expect(h.fetches.length).toBe(before + 2);
  });

  it('ignores packets while the team is not subscribed: focus refreshes instead (E24)', async () => {
    const h = harness(issues(1), { subscribed: false });
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    h.packet({ id: 1, action: 'A', model: 'Issue', rowId: 'x' });
    expect(h.pendingTimers()).toBe(0);
  });

  it("ignores a live edit, another team's row and other models", async () => {
    const h = harness(issues(1));
    h.held.set('live-eng', TEAM.id);
    h.held.set('other', 'team-des');
    const source = new ArchiveSource('archived', TEAM, h.deps);
    source.start();
    await flush();
    h.packet({ id: 1, action: 'U', model: 'Issue', rowId: 'live-eng' });
    h.packet({ id: 2, action: 'A', model: 'Issue', rowId: 'other' });
    h.packet({ id: 3, action: 'A', model: 'Comment', rowId: 'c' });
    h.packet({ id: 4, action: 'I', model: 'Issue', rowId: 'new' });
    expect(h.pendingTimers()).toBe(0);
  });

  it('stops listening and drops answers in flight once stopped', async () => {
    const h = harness(issues(1));
    const source = new ArchiveSource('archived', TEAM, h.deps);
    const stop = source.start();
    stop();
    await flush();
    expect(source.getState().status).toBe('loading');
    h.focus();
    h.packet({ id: 1, action: 'A', model: 'Issue', rowId: 'x' });
    expect(h.fetches).toHaveLength(1);
    expect(h.pendingTimers()).toBe(0);
  });
});
