/**
 * Which tab sends which queue (SPEC-002 AC-6, E5; `owner.ts`): a reload
 * adopts the queue it left, two open tabs keep separate queues, and on
 * origins without Web Locks a crashed tab's queue is adopted once its lease
 * runs out, after which the old tab can no longer write it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { MUTATE_PATH } from '@surface/sync-protocol';
import type { SocketFactory } from '../src/socket.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { replicaName } from '../src/storage/open.js';
import { FakeHub } from './support/hub.js';
import { clientItems, eventually, liveStore, serverItems, until } from './support/live.js';
import { DebugItem, TEST_MODELS, id } from './support/models.js';
import { debugHide, debugRename, debugTouch } from './support/ops.js';
import { gatedResponse } from './support/server.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

const TAB_A = '0190f4c4-0000-7000-8000-00000000000a';
const TAB_B = '0190f4c4-0000-7000-8000-00000000000b';
const TAB_C = '0190f4c4-0000-7000-8000-00000000000c';

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

/** A socket that only connects while `up`. */
function switchable(hub: FakeHub) {
  const network = { up: false };
  const socket: SocketFactory = (url, handlers) => {
    if (!network.up) throw new Error('offline');
    return hub.socket(url, handlers);
  };
  return { network, socket };
}

/** Read the replica's persisted queue through a connection of its own. */
async function persistedQueue(workspaceId: string) {
  const storage = await IndexedDbStorage.open(
    replicaName(workspaceId, 'user-1'),
    TEST_MODELS.map((model) => model.name),
  );
  try {
    return await storage.readQueue();
  } finally {
    await storage.close();
  }
}

describe('reload (AC-6)', () => {
  it('shows a change made offline after a reload, and sends it once back online', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const { network, socket } = switchable(hub);
    const tab = { workspaceId, connectStorage: connectViaRpc, connection: { socket } };

    const before = liveStore(hub, { ...tab, clientId: TAB_A });
    await before.store.start();
    void before.store.dispatch(debugRename, { id: id(1), title: 'Offline edit' });
    await before.store.close();

    const after = liveStore(hub, { ...tab, clientId: TAB_B });
    expect(await after.store.start()).toBe('warm');
    expect(after.store.clientId).toBe(TAB_A);
    expect(after.store.pool.get(DebugItem, id(1))?.title).toBe('Offline edit');
    expect(after.store.pending).toMatchObject([{ seq: 1, op: 'debug.rename', state: 'queued' }]);
    expect(hub.mutateRequests).toEqual([]);

    network.up = true;
    after.timers.runNext();
    await until(() => after.store.pending.length === 0);
    expect(hub.executed()).toBe(1);
    expect(hub.mutateRequests[0]).toMatchObject({ clientId: TAB_A });
    expect(clientItems(after.store)).toEqual(serverItems(hub));
    expect((await persistedQueue(workspaceId)).pending).toEqual([]);
    await after.store.close();
  });
});

describe('several tabs (E5)', () => {
  it('gives each open tab its own queue, and a later tab adopts the one left behind', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const offline = switchable(hub);
    const a = liveStore(hub, {
      workspaceId,
      connectStorage: connectViaRpc,
      clientId: TAB_A,
      connection: { socket: offline.socket },
    });
    await a.store.start();
    void a.store.dispatch(debugTouch, { id: id(1) });
    await eventually(async () => (await persistedQueue(workspaceId)).pending.length === 1);

    // A is still open: B must not take its queue, even though it has work waiting.
    const b = liveStore(hub, { workspaceId, connectStorage: connectViaRpc, clientId: TAB_B });
    await b.store.start();
    expect(b.store.clientId).toBe(TAB_B);
    expect(b.store.pending).toEqual([]);
    await until(() => b.store.connection === 'online');
    await b.store.dispatch(debugTouch, { id: id(2) });
    expect(hub.mutateRequests.map((r) => r.clientId)).toEqual([TAB_B]);

    await a.store.close();
    const c = liveStore(hub, { workspaceId, connectStorage: connectViaRpc, clientId: TAB_C });
    await c.store.start();
    expect(c.store.clientId).toBe(TAB_A);
    await until(() => c.store.pending.length === 0);
    expect(hub.mutateRequests.map((r) => [r.clientId, r.mutations.map((m) => m.seq)])).toEqual([
      [TAB_B, [1]],
      [TAB_A, [1]],
    ]);
    await until(() => b.store.pool.get(DebugItem, id(1))?.counter === 2);
    expect(clientItems(c.store)).toEqual(serverItems(hub));
    await b.store.close();
    await c.store.close();
  });
});

describe('adopting with Web Locks', () => {
  it('adopts a queue with mutations waiting before an empty one', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const offline = switchable(hub);
    const tab = {
      workspaceId,
      connectStorage: connectViaRpc,
      connection: { socket: offline.socket },
    };
    // Two tabs open at once, so two queues; A's (the lower id) stays empty.
    const a = liveStore(hub, { ...tab, clientId: TAB_A });
    await a.store.start();
    const b = liveStore(hub, { ...tab, clientId: TAB_B });
    await b.store.start();
    void b.store.dispatch(debugTouch, { id: id(1) });
    await a.store.close();
    await b.store.close();

    const c = liveStore(hub, { ...tab, clientId: TAB_C });
    await c.store.start();
    expect(c.store.clientId).toBe(TAB_B);
    expect(c.store.pending).toMatchObject([{ seq: 1, op: 'debug.touch' }]);
    await c.store.close();
  });
});

describe('a resend the replica already includes', () => {
  it('is confirmed at once when the answer names a commit the replica has passed', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const tab = { workspaceId, connectStorage: connectViaRpc };
    const a = liveStore(hub, { ...tab, clientId: TAB_A });
    await a.store.start();
    await until(() => a.store.connection === 'online');
    // A's response is lost and its socket stalls: it never hears about its commit.
    hub.last.paused = true;
    hub.loseResponses = 1;
    void a.store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1);

    // Another tab stores the commit in the shared replica; then A reloads.
    const b = liveStore(hub, { ...tab, clientId: TAB_B });
    await b.store.start();
    await until(() => b.store.pool.get(DebugItem, id(1))?.counter === 2);
    await a.store.close();
    const reloaded = liveStore(hub, { ...tab, clientId: TAB_C });
    expect(await reloaded.store.start()).toBe('warm');
    expect(reloaded.store.clientId).toBe(TAB_A);
    expect(reloaded.store.position?.lastSyncId).toBe(hub.head);

    // The resend is answered from the server's record; no delta (or ack) follows.
    await until(() => reloaded.store.pending.length === 0);
    expect(hub.executed()).toBe(1);
    expect(reloaded.store.pool.get(DebugItem, id(1))?.counter).toBe(2);
    await b.store.close();
    await reloaded.store.close();
  });
});

describe('without Web Locks (plain-HTTP origins)', () => {
  it('adopts a crashed tab’s queue once its lease runs out, and fences the old tab', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const offline = switchable(hub);
    let now = 1_000_000;
    const tab = { workspaceId, connectStorage: connectViaRpc, locks: null, clock: () => now };

    const a = liveStore(hub, { ...tab, clientId: TAB_A, connection: { socket: offline.socket } });
    await a.store.start();
    void a.store.dispatch(debugRename, { id: id(1), title: 'From the crashed tab' });
    await eventually(async () => (await persistedQueue(workspaceId)).pending.length === 1);
    // A "crashes": it is never closed, and its timers (the lease renewal) never run.

    now += 10_000; // A's lease (15 s) still holds
    const b = liveStore(hub, { ...tab, clientId: TAB_B });
    await b.store.start();
    expect(b.store.clientId).toBe(TAB_B);
    expect(b.store.pool.get(DebugItem, id(1))?.title).toBe('Item 1');
    await b.store.close(); // leaves an empty queue behind, adoptable at once

    now += 6_000; // A's lease ran out
    const c = liveStore(hub, { ...tab, clientId: TAB_C });
    await c.store.start();
    expect(c.store.clientId).toBe(TAB_A); // the queue with work, before B's empty one
    await until(() => c.store.pending.length === 0);
    expect(serverItems(hub)[id(1)]?.title).toBe('From the crashed tab');
    expect(hub.mutateRequests.map((r) => r.clientId)).toEqual([TAB_A]);

    // A wakes up (its timers were throttled): its renewal finds C owns the queue.
    a.timers.advance(5_000);
    await until(() => a.store.status === 'failed');
    expect(a.store.error).toBe(
      'Another tab took over the changes waiting to be sent. Reload this tab.',
    );
    expect(() => a.store.dispatch(debugTouch, { id: id(1) })).toThrow(/Reload this tab/);
    expect(a.store.connection).toBe('disconnected');

    // Starting again (what a reload does) claims a queue of its own (review m5).
    await a.store.start();
    expect(a.store.status).toBe('ready');
    expect(a.store.error).toBeUndefined();
    expect([TAB_A, TAB_C]).not.toContain(a.store.clientId);
    offline.network.up = true;
    a.timers.runNext();
    expect(await a.store.dispatch(debugTouch, { id: id(2) })).toEqual({ status: 'confirmed' });
    await a.store.close();
    await c.store.close();
  });

  it('picks up the queue it left before a reload once that lease runs out (AC-6, review M1)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const offline = switchable(hub);
    let now = 1_000_000;
    const tab = {
      workspaceId,
      connectStorage: connectViaRpc,
      locks: null,
      clock: () => now,
      connection: { socket: offline.socket },
    };
    const before = liveStore(hub, { ...tab, clientId: TAB_A });
    await before.store.start();
    void before.store.dispatch(debugRename, { id: id(1), title: 'Before the reload' });
    await eventually(async () => (await persistedQueue(workspaceId)).pending.length === 1);
    // The reload: the page goes without closing the store, so its lease runs on.

    now += 2_000;
    const after = liveStore(hub, { ...tab, clientId: TAB_B });
    await after.store.start();
    expect(after.store.clientId).toBe(TAB_B);
    expect(after.store.pool.get(DebugItem, id(1))?.title).toBe('Item 1');

    // Renewal ticks every 5 s look for a queue left with work once its lease ends.
    for (let tick = 0; tick < 3; tick += 1) {
      now += 5_000;
      after.timers.advance(5_000);
    }
    await until(() => after.store.clientId === TAB_A);
    expect(after.store.pool.get(DebugItem, id(1))?.title).toBe('Before the reload');
    expect(after.store.pending).toMatchObject([{ seq: 1, op: 'debug.rename' }]);

    offline.network.up = true;
    after.timers.runNext();
    await until(() => after.store.pending.length === 0);
    expect(serverItems(hub)[id(1)]?.title).toBe('Before the reload');
    expect(hub.mutateRequests.map((r) => r.clientId)).toEqual([TAB_A]);
    // The empty queue it let go of is forgotten by the next claim.
    const next = liveStore(hub, { ...tab, clientId: TAB_C });
    await next.store.start();
    expect((await persistedQueue(workspaceId)).clients.map((c) => c.clientId)).toEqual([
      TAB_A,
      TAB_C,
    ]);
    await next.store.close();
    await after.store.close();
  });

  it('does not take the empty queue of a frozen tab, which carries on when it wakes (review M1)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    let now = 1_000_000;
    const tab = { workspaceId, connectStorage: connectViaRpc, locks: null, clock: () => now };
    const frozen = liveStore(hub, { ...tab, clientId: TAB_A });
    await frozen.store.start();
    await until(() => frozen.store.connection === 'online');

    now += 20_000; // its timers never ran: the lease lapsed
    const other = liveStore(hub, { ...tab, clientId: TAB_B });
    await other.store.start();
    expect(other.store.clientId).toBe(TAB_B);

    frozen.timers.advance(5_000); // it wakes and renews
    await eventually(async () =>
      (await persistedQueue(workspaceId)).clients.some(
        (c) => c.clientId === TAB_A && c.leaseUntil === now + 15_000,
      ),
    );
    expect(frozen.store.status).toBe('ready');
    expect(await frozen.store.dispatch(debugTouch, { id: id(1) })).toEqual({ status: 'confirmed' });
    expect(frozen.store.clientId).toBe(TAB_A);
    await frozen.store.close();
    await other.store.close();
  });

  it('starts a new queue when its empty one was forgotten while it was frozen (review M1)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    let now = 1_000_000;
    const tab = { workspaceId, connectStorage: connectViaRpc, locks: null, clock: () => now };
    const frozen = liveStore(hub, { ...tab, clientId: TAB_A });
    await frozen.store.start();
    await until(() => frozen.store.connection === 'online');

    now += 2 * 86_400_000; // two days frozen: another tab forgets the empty queue
    const other = liveStore(hub, { ...tab, clientId: TAB_B });
    await other.store.start();
    expect((await persistedQueue(workspaceId)).clients.map((c) => c.clientId)).toEqual([TAB_B]);

    frozen.timers.advance(5_000); // wakes; the renewal finds the queue gone
    await until(() => frozen.store.clientId !== TAB_A);
    expect(frozen.store.status).toBe('ready');
    expect(frozen.store.error).toBeUndefined();
    // Reconnected under the new id, so acks reach it.
    await eventually(() => hub.live.some((c) => c.clientId === frozen.store.clientId));
    expect(hub.live.some((c) => c.clientId === TAB_A)).toBe(false);
    expect(await frozen.store.dispatch(debugHide, { note: 'x' })).toEqual({ status: 'confirmed' });
    await frozen.store.close();
    await other.store.close();
  });

  it('stays failed when its queue is taken over during a cold start (review m5)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    let now = 1_000_000;
    const gated = gatedResponse(hub.snapshot().slice(0, 1), hub.snapshot().slice(1));
    let first = true;
    const fetch: typeof hub.fetch = (url, init) => {
      if (first && !url.endsWith(MUTATE_PATH)) {
        first = false;
        return Promise.resolve(gated.response);
      }
      return hub.fetch(url, init);
    };
    const tab = { workspaceId, connectStorage: connectViaRpc, locks: null, clock: () => now };
    const a = liveStore(hub, { ...tab, clientId: TAB_A, fetch });
    const starting = a.store.start();
    await until(() => a.store.status === 'bootstrapping');
    void a.store.dispatch(debugTouch, { id: id(1) });
    await eventually(async () => (await persistedQueue(workspaceId)).pending.length === 1);

    now += 16_000;
    const c = liveStore(hub, { ...tab, clientId: TAB_C });
    await c.store.start();
    expect(c.store.clientId).toBe(TAB_A);
    a.timers.advance(5_000);
    await until(() => a.store.status === 'failed');

    gated.release(); // the bootstrap finishes after the fence
    await expect(starting).rejects.toThrow(/Another tab took over/);
    expect(a.store.status).toBe('failed');
    expect(a.store.connection).toBe('disconnected');
    expect(() => a.store.dispatch(debugTouch, { id: id(1) })).toThrow(/Reload this tab/);
    await a.store.close();
    await c.store.close();
  });

  it('renews its lease while open, so another tab never takes a live queue', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    let now = 1_000_000;
    const tab = { workspaceId, connectStorage: connectViaRpc, locks: null, clock: () => now };
    const offline = switchable(hub);
    const a = liveStore(hub, { ...tab, clientId: TAB_A, connection: { socket: offline.socket } });
    await a.store.start();
    void a.store.dispatch(debugTouch, { id: id(1) });
    for (let i = 0; i < 6; i += 1) {
      now += 5_000;
      a.timers.advance(5_000);
      const renewedUntil = now + 15_000;
      await eventually(async () =>
        (await persistedQueue(workspaceId)).clients.some(
          (client) => client.clientId === TAB_A && client.leaseUntil === renewedUntil,
        ),
      );
    }

    const b = liveStore(hub, { ...tab, clientId: TAB_B });
    await b.store.start();
    expect(b.store.clientId).toBe(TAB_B);
    expect(a.store.status).toBe('ready');
    await a.store.close();
    await b.store.close();
  });
});
