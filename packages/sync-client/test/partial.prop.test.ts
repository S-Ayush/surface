/**
 * The partial-loading property (SPEC-011 AC-27, AC-29, E30, E31, E35, E36; PLAN-011 S4c), on the
 * fake hub's stand-in team world: two tabs share one IndexedDB replica and the team locks.
 * Random task writes (insert, rename, reassignment, archive, delete, restore by `V` or `U`,
 * purge, parts), team opens beyond the on-demand limit, joins and leaves, held partial answers,
 * socket drops, pruned history and tab reloads interleave. Once quiet, each tab shows exactly what a fresh
 * bootstrap with the same subscriptions shows, and so does a tab started afterwards from the
 * shared replica alone (its stored rows, cursors and sweeps). No archived or deleted task is
 * ever kept. Content (notes) is left out: hydration is PLAN-011 S5b's.
 */
import 'fake-indexeddb/auto';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { SocketFactory } from '../src/socket.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore } from '../src/store.js';
import { PROPERTY_SEED } from './support/fc.js';
import type { HubConnection } from './support/hub.js';
import { FakeHub } from './support/hub.js';
import { eventually, teamStore, teamView, until } from './support/live.js';
import { FakeLocks } from './support/locks.js';
import { OTHER_USER, PARTIAL_TEST_MODELS, USER_ID, id } from './support/models.js';
import { uniqueName } from './support/storage.js';
import type { ManualTimers } from './support/timers.js';

/** Squads: 1 public and 2 private (both the user's), 3–5 public and not the user's at first. */
const PUBLIC_OTHERS = [3, 4, 5] as const;
const NAMES = PARTIAL_TEST_MODELS.map((model) => model.name);
const LIMIT = 2;
/** Task `n` (1–8) lives in squad `squadOf(n)`; its number is `100 + n`. */
const squadOf = (n: number) => (n % 5) + 1;
const taskNo = (n: number) => 100 + n;

type Tab = 0 | 1;
interface TabHandle {
  readonly store: SyncStore;
  readonly timers: ManualTimers;
  /** The hub connections its socket opened, newest last. */
  readonly connections: HubConnection[];
  /** The teams this tab opened, most recent first, at most the limit: it must follow them. */
  readonly opened: string[];
}

type Command =
  | { kind: 'put'; n: number; assignee: 'me' | 'other' | 'none'; title: string }
  | { kind: 'archive' | 'delete' | 'purge'; n: number }
  | { kind: 'restore'; n: number; as: 'V' | 'U' }
  | { kind: 'part'; n: number }
  | { kind: 'open'; tab: Tab; squad: number }
  | { kind: 'join' | 'leave'; squad: number }
  | { kind: 'hold' | 'release' | 'prune' | 'holdAcks' | 'releaseAcks' }
  | { kind: 'drop' | 'tick' | 'reload'; tab: Tab }
  | { kind: 'yield'; turns: number }
  | { kind: 'wait' };

const n = fc.integer({ min: 1, max: 8 });
const tab = fc.constantFrom<Tab>(0, 1);
const other = fc.constantFrom(...PUBLIC_OTHERS);
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('put' as const),
      n,
      assignee: fc.constantFrom('me' as const, 'other' as const, 'none' as const),
      title: fc.constantFrom('A', 'B'),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom('archive' as const, 'delete' as const, 'purge' as const),
      n,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('restore' as const),
      n,
      as: fc.constantFrom<'V' | 'U'>('V', 'U'),
    }),
  },
  {
    weight: 2,
    // A child never moves to another issue (the repo refuses an `issueId` patch, SPEC-011 §5.1).
    arbitrary: fc.record({ kind: fc.constant('part' as const), n }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('open' as const), tab, squad: other }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constantFrom('join' as const, 'leave' as const),
      squad: other,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        'hold' as const,
        'release' as const,
        'prune' as const,
        'holdAcks' as const,
        'releaseAcks' as const,
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom('drop' as const, 'tick' as const, 'reload' as const),
      tab,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('yield' as const),
      turns: fc.integer({ min: 1, max: 5 }),
    }),
  },
  // Let the open tabs finish what they are doing (loads, reconnects): a quiet moment.
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('wait' as const) }) },
);

const PUBLIC_GROUPS = new Set([1, ...PUBLIC_OTHERS].map((s) => `team:${id(s)}`));

/**
 * What a store shows of the team world, without content (S5b). A row's `groups` is cut to the
 * connection of the tab that wrote it last (SPEC-002 Q6), and tabs sharing a replica differ only
 * in the public teams they follow, so its public `team:` groups depend on which tab wrote it.
 * The client never decides on them alone (a row stays when its team is followed or through
 * `user:`, which every tab's connection has), so they are left out of the comparison.
 */
const shown = (store: SyncStore) => {
  const { tasks, parts } = teamView(store);
  const homeOnly = Object.fromEntries(
    Object.entries(tasks).map(([taskId, task]) => {
      const { title, groups } = task as { title: unknown; groups: unknown };
      const kept = Array.isArray(groups)
        ? groups.filter((g) => !PUBLIC_GROUPS.has(String(g)))
        : groups;
      return [taskId, { title, groups: kept }];
    }),
  );
  return { tasks: homeOnly, parts };
};

/** The shared replica's meta, read through a connection of its own. */
async function storedMeta(workspaceId: string) {
  const storage = await IndexedDbStorage.open(`surface-${workspaceId}-${USER_ID}`, NAMES);
  try {
    return await storage.readMeta();
  } finally {
    await storage.close();
  }
}

/** Whether task `no` exists and is neither archived nor deleted. */
const live = (hub: FakeHub, no: number) => {
  const row = hub.tasks.get(id(no));
  return row !== undefined && row['archivedAt'] === null && row['deletedAt'] === null;
};

/** Whether the store's own replica has the user in `team` (what `openTeam` goes by). */
const memberIn = (store: SyncStore, team: string) =>
  store.pool.all('SquadMember').some((m) => m['userId'] === USER_ID && m['teamId'] === team);

/** `list` with `team` opened: most recent first, at most the limit. */
const touched = (list: readonly string[], team: string) =>
  [team, ...list.filter((t) => t !== team)].slice(0, LIMIT);

/** The shared replica's on-demand list, read through a connection of its own. */
async function storedOnDemand(workspaceId: string) {
  const storage = await IndexedDbStorage.open(`surface-${workspaceId}-${USER_ID}`, NAMES);
  try {
    return await storage.readOnDemand();
  } finally {
    await storage.close();
  }
}

it('leaves each tab, and the shared replica, equal to a fresh bootstrap with the same subscriptions', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { maxLength: 30 }), async (commands) => {
      const hub = new FakeHub().withTeams();
      hub.addSquad(1);
      hub.addSquad(2, { private: true });
      for (const s of PUBLIC_OTHERS) hub.addSquad(s);
      hub.join(USER_ID, 1);
      hub.join(USER_ID, 2);
      for (const k of [1, 2, 3, 4, 5]) {
        hub.putTask(taskNo(k), squadOf(k), { creatorId: OTHER_USER });
      }
      hub.putTask(taskNo(6), squadOf(6), { creatorId: USER_ID });

      const workspaceId = uniqueName('ws');
      const locks = new FakeLocks();
      const connect: StorageConnector = (name, models) => IndexedDbStorage.open(name, models);
      const open = (name: string): TabHandle => {
        const connections: HubConnection[] = [];
        const socket: SocketFactory = (url, handlers) => {
          const client = hub.socket(url, handlers);
          const connection = hub.connections.at(-1);
          if (connection !== undefined) connections.push(connection);
          return client;
        };
        const { store, timers } = teamStore(hub, {
          workspaceId,
          connectStorage: connect,
          locks: locks.forTab(name),
          onDemandLimit: LIMIT,
          connection: { socket },
        });
        return { store, timers, connections, opened: [] };
      };
      const all: SyncStore[] = [];
      const tabs: TabHandle[] = [];
      const closed = [false, false];
      /** The model of the replica's on-demand list (`touchOnDemand`), shared by its tabs. */
      let shared: string[] = [];
      /** A tab starting on the replica: it begins with the replica's list (once stored). */
      const begin = async (name: string): Promise<TabHandle> => {
        await eventually(async () => (await storedOnDemand(workspaceId)).join() === shared.join());
        const next = open(name);
        all.push(next.store);
        next.opened.push(...shared);
        await next.store.start();
        return next;
      };
      const restart = async (at: Tab) => {
        tabs[at] = await begin(`tab-${String(all.length)}`);
        closed[at] = false;
      };
      try {
        tabs.push(await begin('a'), await begin('b'));

        for (const c of commands) {
          switch (c.kind) {
            case 'put': {
              const assigneeId =
                c.assignee === 'me' ? USER_ID : c.assignee === 'other' ? OTHER_USER : null;
              hub.putTask(taskNo(c.n), squadOf(c.n), { assigneeId, title: c.title });
              break;
            }
            case 'archive':
              hub.archiveTask(taskNo(c.n));
              break;
            case 'delete':
              hub.deleteTask(taskNo(c.n));
              break;
            case 'restore':
              hub.restoreTask(taskNo(c.n), c.as);
              break;
            case 'purge':
              hub.purgeTask(taskNo(c.n));
              break;
            case 'part':
              // Archived and deleted issues are read-only: their attachments too (SPEC-011 §6.1).
              if (live(hub, taskNo(c.n))) hub.putPart(500 + c.n, taskNo(c.n));
              break;
            case 'open': {
              const t = tabs[c.tab];
              if (closed[c.tab] === true || t === undefined) break;
              const team = id(c.squad);
              // A team the tab sees the user in is not an on-demand team: opening it is a no-op.
              if (!memberIn(t.store, team)) {
                t.opened.splice(0, t.opened.length, ...touched(t.opened, team));
                shared = touched(shared, team);
              }
              t.store.openTeam(team);
              break;
            }
            case 'join':
              if (!hub.isMember(USER_ID, id(c.squad))) hub.join(USER_ID, c.squad);
              break;
            case 'leave':
              hub.leave(USER_ID, c.squad);
              break;
            case 'hold':
              hub.holdPartial = true;
              break;
            case 'release':
              hub.holdPartial = false;
              hub.releasePartial();
              break;
            case 'prune':
              hub.retainedFrom = hub.head + 1;
              break;
            case 'holdAcks':
              hub.holdAcks = true;
              break;
            case 'releaseAcks':
              hub.releaseAcks();
              break;
            case 'drop':
              for (const connection of tabs[c.tab]?.connections ?? []) {
                if (connection.isOpen) connection.close(1006);
              }
              break;
            case 'tick':
              tabs[c.tab]?.timers.runNext();
              break;
            case 'reload':
              // Close the tab, or start a new one in its place: warm, from the shared replica
              // the other tab kept moving meanwhile, so its teams may be behind (E35).
              if (closed[c.tab]) await restart(c.tab);
              else {
                await tabs[c.tab]?.store.close();
                closed[c.tab] = true;
              }
              break;
            case 'yield':
              for (let i = 0; i < c.turns; i += 1) await Promise.resolve();
              break;
            case 'wait':
              hub.holdPartial = false;
              hub.releasePartial();
              hub.releaseAcks();
              await settle(
                hub,
                tabs.filter((_, at) => closed[at] !== true),
              );
              break;
          }
        }

        // Quiesce: answer held loads, keep history, reconnect, then a probe every tab applies.
        hub.holdPartial = false;
        hub.releasePartial();
        hub.releaseAcks();
        hub.retainedFrom = 0;
        // A closed tab starts again only once the open one has caught up and stored it all, so
        // the replica has moved past what the closed tab's teams last saw (E35).
        const open0 = tabs.filter((_, at) => closed[at] !== true);
        await settle(hub, open0);
        const reached = Math.max(...open0.map((t) => t.store.position?.lastSyncId ?? 0));
        await eventually(async () => ((await storedMeta(workspaceId))?.lastSyncId ?? 0) >= reached);
        for (const at of [0, 1] as const) if (closed[at]) await restart(at);
        await settle(hub, tabs);
        for (const t of tabs) await expectFresh(hub, t);
        for (const t of tabs) await t.store.close();

        // A tab started from the shared replica alone shows the same as a fresh bootstrap.
        const later = await begin('c');
        await settle(hub, [later]);
        await expectFresh(hub, later);
      } finally {
        for (const store of all) await store.close();
      }
    }),
    {
      seed: PROPERTY_SEED,
      numRuns: 200,
      examples: [
        // E35: tab A follows squad 3 and closes; squad 3 changes while only tab B (not following
        // it) moves the replica on; tab A starts again behind and must reload and sweep.
        [
          [
            { kind: 'open', tab: 0, squad: 3 },
            { kind: 'wait' },
            { kind: 'reload', tab: 0 },
            { kind: 'put', n: 2, assignee: 'other', title: 'B' },
            { kind: 'purge', n: 7 },
          ],
        ],
        // A team dropped and reopened before its `unsubscribed` ack is followed again.
        [
          [
            { kind: 'open', tab: 0, squad: 3 },
            { kind: 'wait' },
            { kind: 'holdAcks' },
            { kind: 'open', tab: 0, squad: 4 },
            { kind: 'open', tab: 0, squad: 5 },
            { kind: 'open', tab: 0, squad: 3 },
            { kind: 'yield', turns: 5 },
            { kind: 'releaseAcks' },
          ],
        ],
      ],
    },
  );
}, 240_000);

/**
 * Run every tab's reconnects and loads to the end, then one probe write: a tab is caught up when
 * it has applied all its open connection sent after the probe.
 */
async function settle(hub: FakeHub, tabs: readonly TabHandle[]): Promise<void> {
  const loaded = ({ store, opened }: TabHandle) =>
    store.status === 'ready' &&
    store.connection === 'online' &&
    opened.every((team) => store.followedTeams.has(team)) &&
    [...store.followedTeams].every((team) => store.teamLoadState(team) === 'ready');
  for (let round = 0; round < 500 && !tabs.every(loaded); round += 1) {
    for (const t of tabs) if (t.store.connection === 'offline') t.timers.runNext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  hub.putTask(199, 1, { creatorId: OTHER_USER, title: `Probe ${String(hub.head)}` });
  for (const t of tabs) {
    await eventually(() => {
      const live = t.connections.filter((c) => c.isOpen).at(-1);
      return loaded(t) && live !== undefined && t.store.position?.lastSyncId === live.sent;
    });
  }
}

/**
 * The tab follows exactly its private and member teams and the teams the model says it opened,
 * and shows what a fresh store, bootstrapped from the hub and opening those teams, shows.
 */
async function expectFresh(hub: FakeHub, { store, opened }: TabHandle): Promise<void> {
  const members = [...hub.squads.keys()].filter((team) => hub.isMember(USER_ID, team));
  expect([...store.followedTeams].sort()).toEqual([...new Set([...members, ...opened])].sort());
  const teams = opened.filter((team) => !hub.isMember(USER_ID, team));
  const fresh = teamStore(hub, { onDemandLimit: LIMIT }).store;
  try {
    await fresh.start();
    for (const team of teams) fresh.openTeam(team);
    await until(
      () =>
        fresh.connection === 'online' &&
        teams.every(
          (team) => fresh.followedTeams.has(team) && fresh.teamLoadState(team) === 'ready',
        ),
    );
    expect(shown(store)).toEqual(shown(fresh));
    // AC-29: nothing archived or deleted is kept.
    for (const task of store.pool.all('Task')) {
      expect(task['archivedAt'] ?? null).toBeNull();
      expect(task['deletedAt'] ?? null).toBeNull();
    }
  } finally {
    await fresh.close();
  }
}
