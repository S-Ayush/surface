/**
 * AC-5 (unit level): a local change shows in the same frame as the dispatch.
 * The overlay is applied synchronously inside `dispatch`, so a MobX reaction
 * (what re-renders a view) has already run when `dispatch` returns, before any
 * storage write or network round-trip.
 */
import { reaction } from 'mobx';
import { describe, expect, it } from 'vitest';
import { FakeHub } from './support/hub.js';
import { clientItems, liveStore, serverItems, until } from './support/live.js';
import { DebugItem, id } from './support/models.js';
import { debugCreate, debugDelete, debugRename, debugTouch } from './support/ops.js';

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

describe('optimistic updates (AC-5)', () => {
  it('a rename reaches a view before dispatch returns', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    const seen: unknown[] = [];
    const stop = reaction(
      () => store.pool.get(DebugItem, id(1))?.title,
      (title) => seen.push(title),
    );

    const outcome = store.dispatch(debugRename, { id: id(1), title: 'Renamed' });
    expect(seen).toEqual(['Renamed']); // synchronously: same frame
    expect(hub.mutateRequests).toEqual([]); // nothing sent yet

    await until(() => store.connection === 'online');
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(seen).toEqual(['Renamed']); // confirmation does not flicker
    expect(clientItems(store)).toEqual(serverItems(hub));
    stop();
    await store.close();
  });

  it('creates, updates and deletes show at once, and each in one MobX batch', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    let runs = 0;
    const stop = reaction(
      () =>
        store.pool
          .all(DebugItem)
          .map((item) => `${item.title}:${item.counter}`)
          .join(),
      () => (runs += 1),
    );

    void store.dispatch(debugCreate, { id: id(9), title: 'New' });
    void store.dispatch(debugTouch, { id: id(2) });
    void store.dispatch(debugDelete, { id: id(3) });
    expect(runs).toBe(3);
    expect(store.pool.get(DebugItem, id(9))?.title).toBe('New');
    expect(store.pool.get(DebugItem, id(2))?.counter).toBe(3);
    expect(store.pool.get(DebugItem, id(3))).toBeUndefined();
    stop();

    await until(() => store.connection === 'online' && store.pending.length === 0);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});
