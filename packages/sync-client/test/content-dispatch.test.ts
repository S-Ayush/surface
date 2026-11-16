// SPEC-011 §5.3 step 6, §5.4, AC-22, E11; PLAN-011 S5b: a content mutation waits for its parent's
// hydration and page-in before its `optimistic` runs and before it takes a seq; later dispatches
// wait behind it; offline, a parent never hydrated refuses at once. Fake hub, fake-indexeddb.
import { computeSchemaHash } from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentUnavailableError } from '../src/content.js';
import { InvalidInputError } from '../src/queue.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, liveStore, until } from './support/live.js';
import { CONTENT_TEST_MODELS, id } from './support/models.js';
import { debugNote, debugTouch } from './support/ops.js';
import { uniqueName } from './support/storage.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const indexedDb: StorageConnector = (name, models, content) =>
  IndexedDbStorage.open(name, models, content);

/** Items 1 (notes 11, 12) and 2 (note 21), never opened; IndexedDB storage. */
async function started() {
  const hub = new FakeHub();
  hub.schemaHash = computeSchemaHash(CONTENT_TEST_MODELS);
  hub.upsert(1);
  hub.upsert(2);
  hub.upsertNote(11, 1);
  hub.upsertNote(12, 1);
  hub.upsertNote(21, 2);
  const { store, timers } = liveStore(hub, {
    models: CONTENT_TEST_MODELS,
    connectStorage: indexedDb,
    workspaceId: uniqueName('ws'),
  });
  stores.push(store);
  await store.start();
  await until(() => store.connection === 'online');
  const offline = async () => {
    hub.last.close();
    await until(() => store.connection === 'offline');
  };
  return { hub, store, timers, offline };
}

function notes(store: SyncStore, item: number): Record<string, unknown> {
  const rows = store.content.rows(id(item))['Note'] ?? [];
  return Object.fromEntries(rows.map((row) => [row.id, row['body']]));
}

describe('dispatching a content mutation (SPEC-011 §5.3 step 6, AC-22)', () => {
  it('waits for its item’s hydration and page-in, then shows its effect on the paged-in rows', async () => {
    const { hub, store } = await started();
    hub.holdContent = true;
    const outcome = store.dispatch(debugNote, { id: id(12), itemId: id(1), body: 'Mine' });
    await eventually(() => hub.contentRequests.length === 1);
    // No seq taken and no effect yet: the item isn't paged in.
    expect(store.pending).toEqual([]);
    expect(notes(store, 1)).toEqual({});
    hub.releaseContent();
    await until(() => store.pending.length === 1);
    expect(notes(store, 1)).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Mine' });
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.notes.get(id(12))?.['body']).toBe('Mine');
    expect(notes(store, 1)).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Mine' });
  });

  it('dispatches at once for an item already paged in', async () => {
    const { store } = await started();
    await store.content.open(id(1)).ready;
    void store.dispatch(debugNote, { id: id(12), itemId: id(1), body: 'Mine' });
    expect(store.pending.map((p) => p.op)).toEqual(['debug.note']);
    expect(notes(store, 1)[id(12)]).toBe('Mine');
  });

  it('replays a pending mutation on rows paged in again: the overlay is rebuilt (§5.4)', async () => {
    const { hub, store } = await started();
    const handle = store.content.open(id(1));
    await handle.ready;
    hub.failRequests = 1_000; // the mutation stays pending, unsent
    void store.dispatch(debugNote, { id: id(12), itemId: id(1), body: 'Mine' });
    await store.resync(); // the new base holds no content; the open item pages in again
    await until(() => store.content.state(id(1)) === 'ready');
    expect(hub.notes.get(id(12))?.['body']).toBe('Note 12');
    expect(notes(store, 1)).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Mine' });
    handle.release();
  });

  it('keeps call order: a later dispatch takes its seq after the content mutation waiting ahead of it', async () => {
    const { hub, store } = await started();
    hub.holdContent = true;
    const first = store.dispatch(debugNote, { id: id(13), itemId: id(1), body: 'First' });
    const second = store.dispatch(debugTouch, { id: id(2) });
    await eventually(() => hub.contentRequests.length === 1);
    expect(store.pending).toEqual([]);
    hub.releaseContent();
    expect(await first).toEqual({ status: 'confirmed' });
    expect(await second).toEqual({ status: 'confirmed' });
    expect(hub.mutateRequests.flatMap((r) => r.mutations.map((m) => [m.seq, m.op]))).toEqual([
      [1, 'debug.note'],
      [2, 'debug.touch'],
    ]);
  });

  it('refuses invalid input at once, before waiting for anything', async () => {
    const { hub, store } = await started();
    expect(() => store.dispatch(debugNote, { id: id(13), itemId: id(1), body: '' })).toThrow(
      InvalidInputError,
    );
    expect(hub.contentRequests).toEqual([]);
  });
});

describe('offline (E11, AC-22)', () => {
  it('refuses a content mutation on an item never hydrated with "Available when online"', async () => {
    const { store, offline } = await started();
    await offline();
    expect(store.content.state(id(2))).toBe('offline');
    const refused = store.dispatch(debugNote, { id: id(22), itemId: id(2), body: 'x' });
    await expect(refused).rejects.toThrow(ContentUnavailableError);
    await expect(refused).rejects.toThrow('Available when online');
    expect(store.pending).toEqual([]);
    // The chain goes on: a dispatch after the refusal is queued.
    void store.dispatch(debugTouch, { id: id(2) });
    expect(store.pending.map((p) => p.op)).toEqual(['debug.touch']);
  });

  it('queues a content mutation on an item hydrated earlier: it pages in from storage', async () => {
    const { hub, store, offline } = await started();
    const handle = store.content.open(id(1));
    await handle.ready;
    handle.release();
    await offline();
    void store.dispatch(debugNote, { id: id(12), itemId: id(1), body: 'Offline' });
    await until(() => store.pending.length === 1);
    expect(notes(store, 1)[id(12)]).toBe('Offline');
    expect(hub.contentRequests).toHaveLength(1);
  });

  it('refuses a mutation named through a note the store doesn’t hold', async () => {
    const { store, offline } = await started();
    await offline();
    await expect(
      store.dispatch(debugNote, { id: id(21), itemId: id(2), body: 'x', viaNote: true }),
    ).rejects.toThrow('Available when online');
    expect(store.pending).toEqual([]);
  });
});

describe('a parent named through a content row (SPEC-011 §5.3 step 6)', () => {
  it('resolves the row to its item, after the mutation ahead of it created the row', async () => {
    const { hub, store } = await started();
    hub.holdContent = true;
    const created = store.dispatch(debugNote, { id: id(15), itemId: id(1), body: 'New' });
    const edited = store.dispatch(debugNote, {
      id: id(15),
      itemId: id(1),
      body: 'Edited',
      viaNote: true,
    });
    await eventually(() => hub.contentRequests.length === 1);
    hub.releaseContent();
    expect(await created).toEqual({ status: 'confirmed' });
    expect(await edited).toEqual({ status: 'confirmed' });
    expect(notes(store, 1)[id(15)]).toBe('Edited');
    expect(hub.contentRequests).toHaveLength(1);
  });

  it('resolves a held note to its item and dispatches at once once that item is paged in', async () => {
    const { store } = await started();
    await store.content.open(id(1)).ready;
    void store.dispatch(debugNote, { id: id(11), itemId: id(1), body: 'Edited', viaNote: true });
    expect(store.pending.map((p) => p.op)).toEqual(['debug.note']);
    expect(notes(store, 1)[id(11)]).toBe('Edited');
  });
});
