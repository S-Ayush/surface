// SPEC-011 §5.7, AC-27 (unit part), E31; PLAN-011 S4c: the client's team subscriptions on the
// fake hub's stand-in team world. Squad 1 is a public team the user is a member of, squad 2 a
// private one; squads 3–9 are public teams they are not in.
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, keptMemoryStorage, teamStore, teamView, until } from './support/live.js';
import { OTHER_USER, USER_ID, id } from './support/models.js';
import { uniqueName } from './support/storage.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** Task `n` of squad `s` is `id(n)`; tasks are numbered 100 + 10 × squad + k. */
function world(): FakeHub {
  const hub = new FakeHub().withTeams();
  hub.addSquad(1);
  hub.addSquad(2, { private: true });
  for (let s = 3; s <= 9; s += 1) hub.addSquad(s);
  hub.join(USER_ID, 1);
  hub.join(USER_ID, 2);
  for (let s = 1; s <= 9; s += 1) hub.putTask(100 + 10 * s, s, { creatorId: OTHER_USER });
  // The user's own issue in squad 3, which they are not in: held through `user:<id>` (§5.7).
  hub.putTask(131, 3, { creatorId: USER_ID });
  return hub;
}

async function started(hub: FakeHub, options: Parameters<typeof teamStore>[1] = {}) {
  const { store, timers } = teamStore(hub, options);
  stores.push(store);
  await store.start();
  await eventually(() => hub.live.length > 0 && store.teamLoadState(id(1)) === 'ready');
  return { store, timers };
}

const taskIds = (store: SyncStore) => Object.keys(teamView(store).tasks).sort();
const sentOf = (hub: FakeHub, t: 'subscribe' | 'unsubscribe') =>
  hub.connections.flatMap((c) => c.received.flatMap((m) => (m.t === t ? [m.teams] : [])));

describe('subscriptions', () => {
  it('names the member public teams on the socket URL and holds member teams and own issues only', async () => {
    const hub = world();
    const { store } = await started(hub);
    expect(hub.last.teams).toEqual([id(1)]);
    // Squads 1 and 2 (member), and the user's own issue of squad 3 with its groups cut (Q6).
    expect(taskIds(store)).toEqual([id(110), id(120), id(131)]);
    expect(teamView(store).tasks[id(131)]).toEqual({
      title: 'Task 131',
      groups: [`user:${USER_ID}`],
    });
    expect(store.followedTeams).toEqual(new Set([id(1), id(2)]));
  });

  it('subscribes a team opened on demand, loads it with the partial bootstrap and keeps it live (AC-27)', async () => {
    const hub = world();
    const { store } = await started(hub);
    expect(store.teamLoadState(id(3))).toBe('loading');
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    expect(sentOf(hub, 'subscribe')).toEqual([[id(3)]]);
    expect(hub.partialRequests).toEqual([[id(3)]]);
    expect(taskIds(store)).toEqual([id(110), id(120), id(130), id(131)]);
    // The partial bootstrap cuts groups to the connection's: the user's own `user:` group stays.
    expect(teamView(store).tasks[id(131)]).toEqual({
      title: 'Task 131',
      groups: [`team:${id(3)}`, `user:${USER_ID}`],
    });
    hub.putTask(132, 3, { creatorId: OTHER_USER, title: 'Live' });
    await until(() => teamView(store).tasks[id(132)] !== undefined);
    expect(store.followedTeams.has(id(3))).toBe(true);
  });

  it('ignores a private team and a member team: nothing to subscribe', async () => {
    const hub = world();
    const { store } = await started(hub);
    store.openTeam(id(2));
    store.openTeam(id(1));
    store.openTeam(id(999));
    await eventually(() => hub.last.received.length === 0);
    expect(sentOf(hub, 'subscribe')).toEqual([]);
    expect(store.teamLoadState(id(2))).toBe('ready');
    expect(store.teamLoadState(id(999))).toBe('ready');
  });

  it('keeps at most 5 on-demand teams: opening a sixth unsubscribes the least recently opened (E31)', async () => {
    const hub = world();
    const { store } = await started(hub);
    for (const s of [3, 4, 5, 6, 7]) {
      store.openTeam(id(s));
      await until(() => store.teamLoadState(id(s)) === 'ready');
    }
    // Reopening 3 makes 4 the least recently opened.
    store.openTeam(id(3));
    store.openTeam(id(8));
    await until(() => store.teamLoadState(id(8)) === 'ready');
    expect(sentOf(hub, 'unsubscribe')).toEqual([[id(4)]]);
    await until(() => teamView(store).tasks[id(140)] === undefined);
    expect(store.followedTeams.has(id(4))).toBe(false);
    expect(taskIds(store)).toContain(id(130));
  });

  it('stores the on-demand teams per replica, and a new start subscribes them on the URL', async () => {
    const hub = world();
    const workspaceId = uniqueName('ws');
    const connect: StorageConnector = (name, models) => IndexedDbStorage.open(name, models);
    const first = await started(hub, { workspaceId, connectStorage: connect, locks: null });
    for (const s of [3, 4]) {
      first.store.openTeam(id(s));
      await until(() => first.store.teamLoadState(id(s)) === 'ready');
    }
    await first.store.close();
    const storage = await IndexedDbStorage.open(`surface-${workspaceId}-${USER_ID}`, ['DebugItem']);
    expect(await storage.readOnDemand()).toEqual([id(4), id(3)]);
    await storage.close();

    const second = await started(hub, { workspaceId, connectStorage: connect, locks: null });
    expect(hub.last.teams).toEqual([id(1), id(4), id(3)]);
    expect(second.store.followedTeams).toEqual(new Set([id(1), id(2), id(3), id(4)]));
  });

  it('removes a team only on the unsubscribed ack, after applying its packets sent before it (AC-27)', async () => {
    const hub = world();
    const { store } = await started(hub, { onDemandLimit: 1 });
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    // The server is slow: a reassignment to the user is on its way when the user leaves squad 3.
    hub.last.paused = true;
    hub.putTask(130, 3, { assigneeId: USER_ID });
    store.openTeam(id(4));
    await eventually(() => sentOf(hub, 'unsubscribe').length === 1);
    // No ack yet: the team's rows stay.
    expect(taskIds(store)).toContain(id(130));
    hub.last.paused = false;
    hub.last.deliver();
    await until(() => store.teamLoadState(id(4)) === 'ready');
    await until(() => !store.followedTeams.has(id(3)));
    // The reassignment (D+U) applied before the ack, so task 130 is now the user's own and stays,
    // like 131; task 130's groups no longer name squad 3's group once the user isn't following.
    expect(taskIds(store)).toEqual([id(110), id(120), id(130), id(131), id(140)]);
  });

  it('follows a team reopened before its unsubscribed ack: it subscribes again after it', async () => {
    const hub = world();
    const { store } = await started(hub, { onDemandLimit: 1 });
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    // The acks come a network trip later: the user moves to squad 4 and straight back to 3.
    hub.holdAcks = true;
    store.openTeam(id(4));
    store.openTeam(id(3));
    // Squad 4 is dropped again before its lock or `subscribe`; squad 3 is asked for again
    // behind its own `unsubscribe`.
    await eventually(() => sentOf(hub, 'subscribe').length === 2);
    expect(sentOf(hub, 'unsubscribe')).toEqual([[id(3)]]);
    expect(sentOf(hub, 'subscribe')).toEqual([[id(3)], [id(3)]]);
    hub.releaseAcks();
    await until(() => store.followedTeams.has(id(3)) && !store.followedTeams.has(id(4)));
    expect(await store.whenTeamLoaded(id(3))).toBe('ready');
    hub.putTask(132, 3, { creatorId: OTHER_USER, title: 'Still live' });
    await until(() => teamView(store).tasks[id(132)] !== undefined);
    expect(taskIds(store)).toEqual([id(110), id(120), id(130), id(131), id(132)]);
  });

  it('drops the content and children of an issue kept through user: when its team is unsubscribed (§5.3 rule 5)', async () => {
    const hub = world();
    const kept = keptMemoryStorage();
    const { store } = await started(hub, { onDemandLimit: 1, connectStorage: kept.connect });
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    hub.putPart(501, 131);
    // Its content is held once the issue is opened (§5.4).
    expect(await store.content.open(id(131)).ready).toBe('ready');
    hub.putTaskNote(601, 131);
    await until(() => teamView(store).notes[id(601)] !== undefined);
    expect(teamView(store).parts).toEqual({ [id(501)]: id(131) });
    store.openTeam(id(4));
    await until(() => !store.followedTeams.has(id(3)));
    await until(() => teamView(store).notes[id(601)] === undefined);
    expect(teamView(store).parts).toEqual({});
    expect(taskIds(store)).toContain(id(131));
  });

  it('follows membership rows: joining a public team subscribes it, leaving unsubscribes it', async () => {
    const hub = world();
    const { store } = await started(hub);
    hub.join(USER_ID, 5);
    await until(() => store.teamLoadState(id(5)) === 'ready' && store.followedTeams.has(id(5)));
    expect(taskIds(store)).toContain(id(150));
    hub.leave(USER_ID, 5);
    await until(() => !store.followedTeams.has(id(5)));
    await until(() => teamView(store).tasks[id(150)] === undefined);
    expect(sentOf(hub, 'unsubscribe')).toEqual([[id(5)]]);
  });

  it('names its teams again after a reconnect, and reloads none it holds current', async () => {
    const hub = world();
    const { store, timers } = await started(hub);
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    hub.last.close();
    hub.putTask(133, 3, { creatorId: OTHER_USER });
    timers.runNext();
    await eventually(() => hub.live.length === 1);
    expect(hub.last.teams).toEqual([id(1), id(3)]);
    await until(() => teamView(store).tasks[id(133)] !== undefined);
    expect(hub.partialRequests).toEqual([[id(3)]]);
  });

  it('subscribes its on-demand teams again after a full bootstrap and reloads them', async () => {
    const hub = world();
    const { store, timers } = await started(hub);
    store.openTeam(id(3));
    await until(() => store.teamLoadState(id(3)) === 'ready');
    hub.last.close();
    hub.retainedFrom = hub.head + 1;
    hub.putTask(133, 3, { creatorId: OTHER_USER });
    timers.runNext();
    await eventually(() => hub.bootstraps === 2);
    await eventually(() => hub.partialRequests.length === 2);
    await until(() => store.teamLoadState(id(3)) === 'ready');
    expect(hub.last.teams).toEqual([id(1), id(3)]);
    expect(taskIds(store)).toContain(id(133));
  });

  it('settles a wait for a team still loading when the store closes', async () => {
    const hub = world();
    hub.holdPartial = true;
    const { store } = await started(hub);
    store.openTeam(id(3));
    const waiting = store.whenTeamLoaded(id(3));
    await eventually(() => hub.partialRequests.length === 1);
    await store.close();
    expect(await waiting).toBe('loading');
    hub.holdPartial = false;
    hub.releasePartial();
  });

  it('shows a team as offline when it was never loaded and the connection is down (E34)', async () => {
    const hub = world();
    const { store } = await started(hub);
    hub.last.close();
    await until(() => store.connection === 'offline');
    expect(store.teamLoadState(id(3))).toBe('offline');
    expect(store.teamLoadState(id(1))).toBe('ready');
  });
});
