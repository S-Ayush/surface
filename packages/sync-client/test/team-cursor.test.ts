// SPEC-011 §5.7, E35, E36; PLAN-011 S4c: two tabs on one IndexedDB replica. Each team's rows
// carry a cursor (`teamThrough`) that only the tabs following the team move; a tab that finds a
// team behind the replica reloads and sweeps it, and a team's stored rows go only when no tab
// follows it (the team lock), never without Web Locks.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
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
});
