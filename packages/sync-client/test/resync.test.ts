/**
 * Resync (SPEC-002 E7, E8; AC-10, client part): a too-old `since` or changed
 * groups re-bootstrap and keep overlays and pending mutations; a schema
 * change asks for a reload.
 */
import { openDB } from 'idb';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/bootstrap.js';
import { ObjectPool } from '../src/pool.js';
import { replicaName } from '../src/storage/open.js';
import { META_KEY } from '../src/storage/types.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { gatedResponse } from './support/server.js';
import { clientItems, liveStore, serverItems, until } from './support/live.js';
import { DebugItem, debugRow, id } from './support/models.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

/** Stands in for the overlay engine (PLAN-002 S8), which owns the writable pool. */
function writablePool(store: SyncStore): ObjectPool {
  const pool: unknown = store.pool;
  if (!(pool instanceof ObjectPool)) throw new Error('expected the object pool');
  return pool;
}

describe.each([
  ['too_old', 'a long time offline (E8)'],
  ['groups', 'changed sync groups'],
] as const)('resync(%s): %s', (reason, _why) => {
  it('re-bootstraps, keeps overlays and pending mutations, then reconnects from the new position', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const { store, timers } = liveStore(hub, { workspaceId, connectStorage: connectViaRpc });
    await store.start();
    await until(() => store.connection === 'online');

    // A pending mutation (S8) and its optimistic overlay.
    const db = await openDB(replicaName(workspaceId, 'user-1'));
    await db.put('pending', { key: 'pending-1', op: 'debug.rename' });
    db.close();
    writablePool(store).setOverlay('DebugItem', id(7), { row: debugRow(7), archived: false });

    hub.last.close();
    hub.upsert(1, { title: 'Changed while away' });
    hub.remove(2);
    if (reason === 'too_old') hub.retainedFrom = hub.head; // the log before here is pruned
    timers.runNext();
    if (reason === 'groups') {
      await until(() => store.connection === 'online');
      hub.last.send({ t: 'resync', reason: 'groups' });
    }

    await until(
      () => store.status === 'ready' && store.connection === 'online' && hub.bootstraps === 2,
    );
    expect(hub.last.since).toBe(hub.head);
    expect(store.pool.get(DebugItem, id(7))).toBeDefined();
    const { [id(7)]: overlay, ...base } = clientItems(store);
    expect(overlay).toBeDefined();
    expect(base).toEqual(serverItems(hub));

    const after = await openDB(replicaName(workspaceId, 'user-1'));
    expect(await after.get('pending', 'pending-1')).toEqual({
      key: 'pending-1',
      op: 'debug.rename',
    });
    after.close();

    // And live deltas flow again.
    hub.upsert(3, { title: 'Live again' });
    expect(store.pool.get(DebugItem, id(3))?.title).toBe('Live again');
    await store.close();
  });
});

describe('resync(schema): the server was updated (E7)', () => {
  it('asks for a reload, without re-bootstrapping or reconnecting', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
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
    await store.close();
  });

  it('is outdated, not failed, when the bootstrap itself comes from a newer server', async () => {
    const hub = seededHub();
    hub.schemaHash = 'f'.repeat(64);
    const { store } = liveStore(hub);
    await expect(store.start()).rejects.toMatchObject({ name: 'ClientOutdatedError' });
    expect(store.status).toBe('outdated');
    expect(hub.connections).toHaveLength(0);
  });
});

describe('a reload after a server update (E7, AC-10 client part)', () => {
  it('re-bootstraps a replica of the old schema and keeps pending mutations', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const before = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    await before.start();
    await before.close();

    // The replica was written by the previous build: same models, another hash.
    const db = await openDB(replicaName(workspaceId, 'user-1'));
    const meta: unknown = await db.get('meta', META_KEY);
    if (typeof meta !== 'object' || meta === null) throw new Error('expected a stored meta');
    await db.put('meta', { ...meta, schemaHash: 'e'.repeat(64) }, META_KEY);
    await db.put('pending', { key: 'pending-1', op: 'debug.rename' });
    db.close();

    hub.upsert(1, { title: 'Changed by the update' });
    const after = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    expect(await after.start()).toBe('cold');
    expect(clientItems(after)).toEqual(serverItems(hub));
    await after.close();

    const check = await openDB(replicaName(workspaceId, 'user-1'));
    expect(await check.get('pending', 'pending-1')).toEqual({
      key: 'pending-1',
      op: 'debug.rename',
    });
    check.close();
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
