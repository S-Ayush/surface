// SPEC-011 §5.7, E35, E36; PLAN-011 S4c: two tabs on one IndexedDB replica. Each team's rows
// carry a cursor (`teamThrough`) that only the tabs following the team move; a tab that finds a
// team behind the replica reloads and sweeps it, and a team's stored rows go only when no tab
// follows it (the team lock), never without Web Locks.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { IssueShape, SyncStorage } from '../src/storage/types.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, teamStore, teamView, until } from './support/live.js';
import { FakeLocks } from './support/locks.js';
import { OTHER_USER, PARTIAL_TEST_MODELS, USER_ID, id } from './support/models.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

const NAMES = PARTIAL_TEST_MODELS.map((model) => model.name);
const connect: StorageConnector = connectViaRpc;

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
afterAll(closePorts);

function world(): FakeHub {
  const hub = new FakeHub().withTeams();
  hub.addSquad(1);
  hub.addSquad(3);
  hub.addSquad(4);
  hub.join(USER_ID, 1);
  for (const n of [110, 130, 131, 140])
    hub.putTask(n, Math.floor((n - 100) / 10), {
      creatorId: OTHER_USER,
    });
  return hub;
}

/** A tab on the replica of `workspaceId`. */
async function tab(
  hub: FakeHub,
  workspaceId: string,
  locks: FakeLocks | null,
  name: string,
  options: { onDemandLimit?: number } = {},
) {
  const { store } = teamStore(hub, {
    workspaceId,
    connectStorage: connect,
    locks: locks === null ? null : locks.forTab(name),
    ...options,
  });
  stores.push(store);
  await store.start();
  await until(() => store.teamLoadState(id(1)) === 'ready');
  return store;
}

async function open(store: SyncStore, team: number): Promise<void> {
  store.openTeam(id(team));
  await until(() => store.teamLoadState(id(team)) === 'ready' && store.followedTeams.has(id(team)));
}

const SHAPE: IssueShape = {
  issue: 'Task',
  children: [{ model: 'TaskPart', field: 'issueId' }],
  content: [{ model: 'TaskNote', field: 'issueId' }],
};

/** Run `act` on the replica's storage through a connection of its own, as another tab. */
async function onReplica(workspaceId: string, act: (storage: SyncStorage) => Promise<unknown>) {
  const storage = await IndexedDbStorage.open(`surface-${workspaceId}-${USER_ID}`, NAMES);
  try {
    await act(storage);
  } finally {
    await storage.close();
  }
}

/** What the replica's storage holds. */
async function stored(workspaceId: string) {
  const storage = await IndexedDbStorage.open(`surface-${workspaceId}-${USER_ID}`, NAMES);
  try {
    const page = await storage.readRows('Task', undefined, 1000);
    return {
      tasks: page.rows.map((r) => r.row.id).sort(),
      meta: await storage.readMeta(),
    };
  } finally {
    await storage.close();
  }
}

const taskIds = (store: SyncStore) => Object.keys(teamView(store).tasks).sort();

describe('team cursors across tabs', () => {
  it("moves a team's cursor only with the writes of tabs that follow it", async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    const b = await tab(hub, workspaceId, locks, 'b');
    await open(a, 3);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(130)));
    // A squad-1 packet both tabs get: tab A's write moves squad 3's cursor with it, tab B's doesn't.
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    await until(() => teamView(a).tasks[id(111)] !== undefined);
    await until(() => teamView(b).tasks[id(111)] !== undefined);
    const head = hub.head;
    await eventually(async () => (await stored(workspaceId)).meta?.lastSyncId === head);
    await eventually(async () => (await stored(workspaceId)).meta?.teamThrough?.[id(3)] === head);
    expect((await stored(workspaceId)).meta?.teamThrough?.[id(1)]).toBe(head);
    expect(taskIds(b)).toEqual([id(110), id(111)]);
  });

  it('reloads and sweeps a team found behind the replica at a warm start (E35)', async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    const b = await tab(hub, workspaceId, locks, 'b');
    await open(a, 3);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(131)));
    await a.close();
    // While only tab B (not following squad 3) is open: task 131 is purged and a squad-1 packet
    // moves the replica on. Tab B never sees the purge.
    hub.purgeTask(131);
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    await until(() => teamView(b).tasks[id(111)] !== undefined);
    const head = hub.head;
    await eventually(async () => (await stored(workspaceId)).meta?.lastSyncId === head);
    const behind = await stored(workspaceId);
    expect(behind.tasks).toContain(id(131));
    expect(behind.meta?.teamThrough?.[id(3)]).toBeLessThan(head);

    const again = await tab(hub, workspaceId, locks, 'a2');
    // Its stored rows show at once (the team was loaded before); the reload then sweeps them.
    expect(again.teamLoadState(id(3))).toBe('ready');
    await until(() => teamView(again).tasks[id(131)] === undefined);
    expect(hub.partialRequests).toEqual([[id(3)], [id(3)]]);
    expect(taskIds(again)).toEqual([id(110), id(111), id(130)]);
    await eventually(async () => !(await stored(workspaceId)).tasks.includes(id(131)));
    expect((await stored(workspaceId)).meta?.teamThrough?.[id(3)]).toBe(head);
  });

  it('loads an open issue again after the reload sweeps it: once it shows up in another team, it fetches (PLAN-011 S5b)', async () => {
    const hub = world();
    hub.putTaskNote(601, 130);
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    const b = await tab(hub, workspaceId, locks, 'b');
    await open(a, 3);
    expect(await a.content.open(id(130)).ready).toBe('ready');
    await eventually(async () => {
      let hydrated: readonly string[] = [];
      await onReplica(workspaceId, async (storage) => (hydrated = await storage.readHydrated()));
      return hydrated.includes(id(130));
    });
    await a.close();
    // While only tab B (not following squads 3 and 4) is open, task 130 moves to squad 4.
    hub.putTask(130, 4, { creatorId: OTHER_USER });
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    await until(() => teamView(b).tasks[id(111)] !== undefined);
    const head = hub.head;
    await eventually(async () => (await stored(workspaceId)).meta?.lastSyncId === head);

    // A new tab finds squad 3 behind; its issue page for 130 opens from the replica first.
    hub.holdPartial = true;
    const again = await tab(hub, workspaceId, locks, 'a2');
    const handle = again.content.open(id(130));
    expect(await handle.ready).toBe('ready');
    expect(teamView(again).notes).toEqual({ [id(601)]: id(130) });
    // The reload's answer lacks 130: swept, with its content.
    hub.holdPartial = false;
    hub.releasePartial();
    await until(() => teamView(again).tasks[id(130)] === undefined);
    expect(teamView(again).notes).toEqual({});
    expect(hub.contentRequests).toHaveLength(1); // tab A's, before it closed
    // Squad 4's list brings 130 back: the page still open loads its content again.
    await open(again, 4);
    await eventually(() => hub.contentRequests.length === 2);
    await until(() => teamView(again).notes[id(601)] !== undefined);
    expect(again.content.state(id(130))).toBe('ready');
    handle.release();
  });

  it("keeps a team's stored rows while another tab follows it, and removes them after (E36)", async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a', { onDemandLimit: 1 });
    const b = await tab(hub, workspaceId, locks, 'b', { onDemandLimit: 1 });
    await open(a, 3);
    await open(b, 3);
    // Tab A moves on to squad 4: squad 3 leaves its pool, but tab B still follows it.
    await open(a, 4);
    await until(() => !a.followedTeams.has(id(3)) && teamView(a).tasks[id(130)] === undefined);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(140)));
    expect((await stored(workspaceId)).tasks).toContain(id(130));
    expect(taskIds(b)).toContain(id(130));
    // Then tab B leaves it too: no tab follows squad 3, so its rows go.
    await open(b, 4);
    await eventually(async () => !(await stored(workspaceId)).tasks.includes(id(130)));
    expect((await stored(workspaceId)).meta?.teamThrough?.[id(3)]).toBeUndefined();
    expect(locks.held.filter((h) => h.name.endsWith(`:team:${id(3)}`))).toEqual([]);
  });

  it("never removes a team's stored rows without Web Locks", async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const a = await tab(hub, workspaceId, null, 'a', { onDemandLimit: 1 });
    await open(a, 3);
    await open(a, 4);
    await until(() => teamView(a).tasks[id(130)] === undefined);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(140)));
    expect((await stored(workspaceId)).tasks).toContain(id(130));
  });

  it('loads a team the replica holds complete but this tab did not follow at its start', async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    await open(a, 3);
    await eventually(
      async () => (await stored(workspaceId)).meta?.teamThrough?.[id(3)] !== undefined,
    );
    await a.close();
    // Another tab's on-demand list moved on: squad 3 is complete in storage but nobody's.
    await onReplica(workspaceId, (storage) => storage.touchOnDemand(id(4), 1));

    const { store: b } = teamStore(hub, {
      workspaceId,
      connectStorage: connect,
      locks: locks.forTab('b'),
    });
    stores.push(b);
    // Opened after the start, before the connection's first ack.
    hub.holdAcks = true;
    await b.start();
    expect(taskIds(b)).not.toContain(id(130));
    b.openTeam(id(3));
    expect(b.teamLoadState(id(3))).toBe('loading');
    hub.releaseAcks();
    expect(await b.whenTeamLoaded(id(3))).toBe('ready');
    expect(taskIds(b)).toContain(id(130));
    expect(hub.partialRequests.filter((teams) => teams.includes(id(3)))).toHaveLength(2);
  });

  it("reloads a team another tab removed between this tab's cursor read and its shared hold (E36)", async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    await open(a, 3);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(130)));
    await a.close();

    // A tab removing squad 3 holds its lock exclusively while tab B starts.
    const replica = `surface-${workspaceId}-${USER_ID}`;
    const name = `${replica}:team:${id(3)}`;
    let finish: () => void = () => undefined;
    const removing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void locks.forTab('x').request(name, { mode: 'exclusive' }, () => removing);
    const { store: b } = teamStore(hub, {
      workspaceId,
      connectStorage: connect,
      locks: locks.forTab('b'),
    });
    stores.push(b);
    const starting = b.start();
    // B has read the cursors (squad 3 complete) and waits for its shared hold.
    await eventually(() => locks.waiting(name) === 1);
    await onReplica(workspaceId, async (storage) => {
      const meta = await storage.readMeta();
      await storage.removeTeamRows(meta?.generation ?? '', {
        shape: SHAPE,
        teams: [id(3)],
        keep: ['workspace', `user:${USER_ID}`, `team:${id(1)}`],
      });
    });
    finish();
    await starting;
    await eventually(() => hub.partialRequests.length === 2);
    await eventually(async () => (await stored(workspaceId)).tasks.includes(id(130)));
    expect((await stored(workspaceId)).meta?.teamThrough?.[id(3)]).toBeDefined();
  });

  it('lets go of a team lock granted after the store closed', async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    const a = await tab(hub, workspaceId, locks, 'a');
    await open(a, 3);
    await a.close();
    const name = `surface-${workspaceId}-${USER_ID}:team:${id(3)}`;
    let finish: () => void = () => undefined;
    const busy = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void locks.forTab('x').request(name, { mode: 'exclusive' }, () => busy);
    const { store: b } = teamStore(hub, {
      workspaceId,
      connectStorage: connect,
      locks: locks.forTab('b'),
    });
    const starting = b.start().catch(() => undefined);
    await eventually(() => locks.waiting(name) === 1);
    await b.close();
    await starting;
    finish();
    await eventually(() => locks.holders(name).length === 0 && locks.waiting(name) === 0);
  });
});
