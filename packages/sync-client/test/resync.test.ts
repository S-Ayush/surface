/**
 * Resync (SPEC-002 E7, E8; AC-10, client part): a too-old `since` or changed
 * groups re-bootstrap and keep overlays and pending mutations; a schema
 * change asks for a reload.
 */
import { openDB } from 'idb';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/bootstrap.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { replicaName } from '../src/storage/open.js';
import { META_KEY } from '../src/storage/types.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { gatedResponse } from './support/server.js';
import { clientItems, eventually, idle, liveStore, serverItems, until } from './support/live.js';
import { debugRename, debugTouch } from './support/ops.js';
import type { ManualTimers } from './support/timers.js';
import { DebugItem, TEST_MODELS, id } from './support/models.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

/** Run timers until the store is connected again (its retries share the timers). */
async function reconnect(store: SyncStore, timers: ManualTimers): Promise<void> {
  for (let i = 0; i < 10 && store.connection !== 'online'; i += 1) {
    timers.runNext();
    await idle(2);
  }
  await until(() => store.connection === 'online');
}

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

describe.each([
  ['too_old', 'a long time offline (E8)'],
  ['groups', 'changed sync groups'],
] as const)('resync(%s): %s', (reason, _why) => {
  it('re-bootstraps, keeps a dispatched mutation and its effect, reconnects, then sends it (review M4)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const { store, timers } = liveStore(hub, { workspaceId, connectStorage: connectViaRpc });
    await store.start();
    await until(() => store.connection === 'online');

    // A pending mutation the server cannot take yet, and its optimistic effect.
    hub.failRequests = Number.POSITIVE_INFINITY;
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => timers.pending.includes(500));
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(2);

    hub.last.close();
    hub.upsert(1, { title: 'Changed while away', counter: 10 });
    hub.remove(2);
    if (reason === 'too_old') hub.retainedFrom = hub.head; // the log before here is pruned
    await reconnect(store, timers);
    if (reason === 'groups') hub.last.send({ t: 'resync', reason: 'groups' });
    await eventually(() => hub.bootstraps === 2);
    await until(() => store.status === 'ready' && store.connection === 'online');
    expect(hub.last.since).toBe(hub.head);

    // The new base, with the pending touch still on top, and still persisted.
    expect(store.pool.get(DebugItem, id(1))).toMatchObject({
      title: 'Changed while away',
      counter: 11,
    });
    expect(store.pending).toMatchObject([{ seq: 1, op: 'debug.touch' }]);
    expect((await persistedQueue(workspaceId)).pending).toMatchObject([{ seq: 1 }]);

    // And live deltas flow again; the mutation goes out once the server takes it.
    hub.upsert(3, { title: 'Live again' });
    expect(store.pool.get(DebugItem, id(3))?.title).toBe('Live again');
    hub.failRequests = 0;
    while (store.pending.length > 0 && timers.runNext() !== undefined) await idle(2);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(serverItems(hub)[id(1)]?.counter).toBe(11);
    await store.close();
  });
});

describe('resync(schema): the server was updated (E7)', () => {
  it('asks for a reload once, without re-bootstrapping or reconnecting', async () => {
    const hub = seededHub();
    const onOutdated = vi.fn();
    const { store, timers } = liveStore(hub, { onOutdated });
    await store.start();
    await until(() => store.connection === 'online');

    hub.schemaHash = 'f'.repeat(64); // deploy
    hub.last.close(1012);
    timers.runNext();
    await until(() => store.status === 'outdated');
    expect(store.connection).toBe('disconnected');
    expect(timers.pending).toEqual([]);
    expect(hub.bootstraps).toBe(1);
    expect(hub.connections).toHaveLength(2);
    expect(onOutdated).toHaveBeenCalledOnce(); // review m1: not only for a mutate 426
    await store.close();
  });

  it('is outdated, not failed, when the bootstrap itself comes from a newer server', async () => {
    const hub = seededHub();
    hub.schemaHash = 'f'.repeat(64);
    const onOutdated = vi.fn();
    const { store } = liveStore(hub, { onOutdated });
    await expect(store.start()).rejects.toMatchObject({ name: 'ClientOutdatedError' });
    expect(store.status).toBe('outdated');
    expect(onOutdated).toHaveBeenCalledOnce();
    expect(hub.connections).toHaveLength(0);
  });
});

describe('a reload after a server update (E7, AC-10 client part)', () => {
  it('re-bootstraps a replica of the old schema and keeps pending mutations (review M4)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const before = liveStore(hub, { workspaceId, connectStorage: connectViaRpc });
    await before.store.start();
    await until(() => before.store.connection === 'online');
    hub.failRequests = Number.POSITIVE_INFINITY;
    void before.store.dispatch(debugRename, { id: id(1), title: 'Made before the update' });
    await eventually(() => before.timers.pending.includes(500));
    await before.store.close();

    // The replica was written by the previous build: same models, another hash.
    const db = await openDB(replicaName(workspaceId, 'user-1'));
    const meta: unknown = await db.get('meta', META_KEY);
    if (typeof meta !== 'object' || meta === null) throw new Error('expected a stored meta');
    await db.put('meta', { ...meta, schemaHash: 'e'.repeat(64) }, META_KEY);
    db.close();

    hub.upsert(2, { title: 'Changed by the update' });
    const after = liveStore(hub, { workspaceId, connectStorage: connectViaRpc });
    expect(await after.store.start()).toBe('cold');
    expect(after.store.pool.get(DebugItem, id(1))?.title).toBe('Made before the update');
    expect(after.store.pool.get(DebugItem, id(2))?.title).toBe('Changed by the update');
    expect(after.store.pending).toMatchObject([{ seq: 1, op: 'debug.rename' }]);

    hub.failRequests = 0;
    while (after.store.pending.length > 0 && after.timers.runNext() !== undefined) await idle(2);
    expect(hub.executed()).toBe(1);
    expect(clientItems(after.store)).toEqual(serverItems(hub));
    await after.store.close();
  });
});

describe('a re-bootstrap that fails', () => {
  it('is retried through the connection until it succeeds', async () => {
    const hub = seededHub();
    let failNext = false;
    const fetch: FetchLike = (url, init) =>
      failNext
        ? ((failNext = false), Promise.resolve(new Response('busy', { status: 503 })))
        : hub.fetch(url, init);
    const { store, timers } = liveStore(hub, { fetch });
    await store.start();
    await until(() => store.connection === 'online');

    hub.last.close();
    hub.upsert(1, { title: 'Changed while away' });
    hub.retainedFrom = hub.head;
    failNext = true;
    timers.runNext();
    await until(() => store.status === 'failed' && store.connection === 'offline');

    timers.runNext(); // reconnect; the server asks for a resync again
    await until(() => store.status === 'ready' && store.connection === 'online');
    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(hub.last.since).toBe(hub.head);
    await store.close();
  });
});

describe('a resync overlapping a start (review S7 #1)', () => {
  it('applies no live deltas while it re-bootstraps, and reconnects from the new position', async () => {
    const hub = seededHub();
    let finishSnapshot: () => void = () => undefined;
    let requested: (take: () => void) => void = () => undefined;
    const snapshotRequested = new Promise<() => void>((resolve) => (requested = resolve));
    let fetches = 0;
    const fetch: FetchLike = (url, init) => {
      fetches += 1;
      if (fetches === 1) return hub.fetch(url, init);
      // The resync's snapshot is taken when the test says, and its end frame held back.
      return new Promise((resolve) => {
        requested(() => {
          hub.bootstraps += 1;
          const frames = hub.snapshot();
          const gated = gatedResponse(frames.slice(0, -1), frames.slice(-1));
          finishSnapshot = gated.release;
          resolve(gated.response);
        });
      });
    };
    const { store } = liveStore(hub, { fetch, chunkSize: 1 });
    const starting = store.start();
    const resyncing = store.resync();
    await starting;
    const first = hub.last;
    const before = first.sent;

    // Two writes the first connection has not delivered yet: X = A, then X = B.
    first.paused = true;
    hub.upsert(1, { title: 'A' });
    hub.upsert(1, { title: 'B' });
    const takeSnapshot = await snapshotRequested;
    takeSnapshot(); // the snapshot has X = B at the head
    await until(() => store.pool.get(DebugItem, id(1))?.title === 'B');

    // The old connection now delivers the older write...
    const older = hub.log.at(-2);
    if (older === undefined) throw new Error('expected the older write');
    first.send({ t: 'deltas', prev: before, packets: [older], ack: [] });
    first.sent = older.id;
    finishSnapshot();
    await resyncing;
    // ...and, after the resync, the newer one.
    first.paused = false;
    first.deliver();

    await until(() => store.connection === 'online' && hub.last !== first, 1000);
    expect(hub.last.since).toBe(hub.head);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});

describe('a resync that fails (review S7 #4)', () => {
  it('is retried by the client once the server is reachable, until the store is ready again', async () => {
    const hub = seededHub();
    let failNext = false;
    const fetch: FetchLike = (url, init) =>
      failNext
        ? ((failNext = false), Promise.resolve(new Response('busy', { status: 503 })))
        : hub.fetch(url, init);
    const { store, timers } = liveStore(hub, { fetch });
    await store.start();
    await until(() => store.connection === 'online');

    hub.remove(2); // must disappear through the re-bootstrap's sweep
    failNext = true;
    await expect(store.resync()).rejects.toMatchObject({ status: 503 });
    expect(store.status).toBe('failed');

    timers.runNext(); // the connection comes back; the client re-runs the resync itself
    await until(() => store.status === 'ready' && store.connection === 'online');
    expect(hub.bootstraps).toBe(2);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});
