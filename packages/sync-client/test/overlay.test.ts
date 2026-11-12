/**
 * The overlay follows the base (SPEC-002 §5.2): when another user's change
 * reaches a row a pending mutation read or wrote, the overlay is recomputed
 * from the new base, so the screen shows their change with ours on top.
 */
import { defineModel, str, timestamp } from '@surface/domain/model';
import { defineOperation } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
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

/** A model that archives through a declared `archivedAt` (SPEC-011 §5.5), like Label from S2. */
const Shelf = defineModel('Shelf', {
  load: 'eager',
  fields: { name: str(), archivedAt: timestamp().nullable() },
});

const archiveFixture = (verb: 'archive' | 'unarchive', summary: string) =>
  defineOperation({
    name: `debug.${verb}Fixture`,
    kind: 'mutation',
    domain: 'debug',
    summary,
    description: 'Archives or unarchives a row of any model through the store. For overlay tests.',
    keywords: [`${verb} row`, 'overlay fixture'],
    input: z.object({ model: z.string(), id: z.uuid() }),
    output: z.object({}),
    examples: [{ model: 'Shelf', id: id(1) }],
    permission: () => true,
    destructive: false,
    internal: true,
    optimistic(store, input) {
      store[verb](input.model, input.id);
    },
  });
const archiveRow = archiveFixture('archive', 'Archive a row (fixture)');
const unarchiveRow = archiveFixture('unarchive', 'Unarchive a row (fixture)');

describe('store.archive and store.unarchive (SPEC-011 §6.3)', () => {
  const now = new Date('2026-11-12T10:00:00.000Z');
  const step = (key: string, op: OverlayMutation['op'], model: string, n: number) => ({
    key,
    op,
    input: { model, id: id(n) },
    now,
  });

  function setup() {
    const pool = new ObjectPool([Shelf, DebugItem]);
    pool.loadBase('Shelf', [
      {
        row: { id: id(1), name: 'Live', archivedAt: null, groups: ['workspace'] },
        archived: false,
      },
      {
        row: {
          id: id(2),
          name: 'Old',
          archivedAt: '2026-01-01T00:00:00.000Z',
          groups: ['workspace'],
        },
        archived: true,
      },
    ]);
    pool.loadBase('DebugItem', [
      { row: { id: id(3), title: 'Item', counter: 1, groups: ['workspace'] }, archived: true },
      { row: { id: id(4), title: 'Item', counter: 4, groups: ['workspace'] }, archived: false },
    ]);
    return { pool, engine: new OverlayEngine(pool, () => undefined) };
  }

  it('archive sets archivedAt to the mutation time on a model that declares it', () => {
    const { pool, engine } = setup();
    engine.push(step('c:1', archiveRow, 'Shelf', 1));
    expect(pool.get(Shelf, id(1))).toMatchObject({
      $archived: true,
      archivedAt: '2026-11-12T10:00:00.000Z',
      name: 'Live',
    });
  });

  it('unarchive clears the flag and sets archivedAt to null on a model that declares it', () => {
    const { pool, engine } = setup();
    engine.push(step('c:1', unarchiveRow, 'Shelf', 2));
    expect(pool.get(Shelf, id(2))).toMatchObject({
      $archived: false,
      archivedAt: null,
      name: 'Old',
    });
  });

  it('archive and unarchive change only the flag on a model without archivedAt', () => {
    const { pool, engine } = setup();
    const shown = vi.spyOn(pool, 'setOverlay');
    engine.rebuild([
      step('c:1', unarchiveRow, 'DebugItem', 3),
      step('c:2', archiveRow, 'DebugItem', 4),
    ]);
    const unarchived = pool.get(DebugItem, id(3));
    const archived = pool.get(DebugItem, id(4));
    expect(unarchived?.$archived).toBe(false);
    expect(archived?.$archived).toBe(true);
    expect(unarchived).toMatchObject({ title: 'Item', counter: 1 });
    expect(archived).toMatchObject({ title: 'Item', counter: 4 });
    // The overlay rows are the base rows: nothing but the flag changed.
    expect(shown.mock.calls).toEqual([
      ['DebugItem', id(3), { row: pool.baseOf('DebugItem', id(3))?.row, archived: false }],
      ['DebugItem', id(4), { row: pool.baseOf('DebugItem', id(4))?.row, archived: true }],
    ]);
  });

  it('an unarchive after an archive in the queue leaves the row live, and a rebuild agrees', () => {
    const { pool, engine } = setup();
    const list = [step('c:1', archiveRow, 'Shelf', 1), step('c:2', unarchiveRow, 'Shelf', 1)];
    engine.rebuild(list);
    expect(pool.get(Shelf, id(1))).toMatchObject({ $archived: false, archivedAt: null });
    engine.rebuild(list);
    expect(pool.get(Shelf, id(1))).toMatchObject({ $archived: false, archivedAt: null });
  });

  it('does nothing for a row the store does not hold', () => {
    const { pool, engine } = setup();
    engine.push(step('c:1', unarchiveRow, 'Shelf', 9));
    expect(pool.get(Shelf, id(9))).toBeUndefined();
  });
});
