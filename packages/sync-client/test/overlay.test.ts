/**
 * The overlay follows the base (SPEC-002 §5.2): when another user's change
 * reaches a row a pending mutation read or wrote, the overlay is recomputed
 * from the new base, so the screen shows their change with ours on top.
 */
import { describe, expect, it } from 'vitest';
import { FakeHub } from './support/hub.js';
import { clientItems, eventually, liveStore, serverItems, until } from './support/live.js';
import { DebugItem, id } from './support/models.js';
import { debugCreate, debugRename, debugTouch } from './support/ops.js';

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

/**
 * A store whose sends fail until `deliverMutations()`. `stalled()` waits for
 * the first failed send, so the mutations are persisted and waiting to retry.
 */
async function stalledStore() {
  const hub = seededHub();
  const { store, timers } = liveStore(hub);
  await store.start();
  await until(() => store.connection === 'online');
  hub.failRequests = Number.POSITIVE_INFINITY;
  const stalled = () => eventually(() => timers.pending.includes(500));
  const deliverMutations = () => {
    hub.failRequests = 0;
    expect(timers.runNext()).toBe(500);
  };
  return { hub, store, stalled, deliverMutations };
}

describe('the overlay over a changing base', () => {
  it('recomputes a pending change on top of another user’s change to the same row', async () => {
    const { hub, store, stalled, deliverMutations } = await stalledStore();
    void store.dispatch(debugTouch, { id: id(1) });
    void store.dispatch(debugRename, { id: id(2), title: 'Ours' });
    await stalled();
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(2);

    hub.upsert(1, { counter: 10 }); // someone else, while ours is unsent
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(11);
    hub.upsert(2, { counter: 7, title: 'Theirs' });
    expect(store.pool.get(DebugItem, id(2))).toMatchObject({ title: 'Ours', counter: 7 });

    deliverMutations();
    await until(() => store.pending.length === 0);
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(11);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('shows a pending insert, and drops it if the server deletes the row it patched', async () => {
    const { hub, store, stalled, deliverMutations } = await stalledStore();
    const created = '0190f4c4-0000-7000-8000-0000000000e1';
    void store.dispatch(debugCreate, { id: created, title: 'New' });
    void store.dispatch(debugRename, { id: id(3), title: 'Renamed' });
    expect(store.pool.get(DebugItem, created)?.title).toBe('New');
    expect(store.pool.get(DebugItem, id(3))?.title).toBe('Renamed');
    await stalled();

    hub.remove(3); // gone on the server: the rename has nothing left to patch
    expect(store.pool.get(DebugItem, id(3))).toBeUndefined();

    deliverMutations();
    await until(() => store.pending.length === 0);
    expect(store.rejections).toMatchObject([{ op: 'debug.rename', code: 'NOT_FOUND' }]);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('does not recompute for changes to rows no pending mutation used', async () => {
    const { hub, store, stalled } = await stalledStore();
    void store.dispatch(debugTouch, { id: id(1) });
    await stalled();
    const before = store.pool.get(DebugItem, id(1));
    hub.upsert(2, { counter: 99 });
    // The same instance: the overlay row was not rebuilt.
    expect(store.pool.get(DebugItem, id(1))).toBe(before);
    expect(store.pool.get(DebugItem, id(2))?.counter).toBe(99);
    await store.close();
  });
});
