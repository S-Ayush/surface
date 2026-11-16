// SPEC-012 §3.4 item 8, AC-26 (client part); PLAN-012 S4b: `content.peek` reads an issue's content
// once from `GET /sync/content` for the read-only view of an archived or deleted issue. The rows
// are returned and kept nowhere: not in the pool, not in storage, and the parent is not hydrated,
// so later packets for it are still dropped.
import { computeSchemaHash, issueParent } from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import {
  eventually,
  keptMemoryStorage,
  liveStore,
  teamStore,
  teamView,
  until,
} from './support/live.js';
import { CONTENT_TEST_MODELS, OTHER_USER, USER_ID, id } from './support/models.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** Items 1 (notes 11, 12) and 2 (note 21). */
async function itemWorld() {
  const hub = new FakeHub();
  hub.schemaHash = computeSchemaHash(CONTENT_TEST_MODELS);
  hub.upsert(1);
  hub.upsert(2);
  hub.upsertNote(11, 1);
  hub.upsertNote(12, 1);
  hub.upsertNote(21, 2);
  const kept = keptMemoryStorage();
  const { store, timers } = liveStore(hub, {
    models: CONTENT_TEST_MODELS,
    connectStorage: kept.connect,
  });
  stores.push(store);
  await store.start();
  await until(() => store.connection === 'online');
  return { hub, store, kept, timers };
}

const bodies = (rows: readonly Record<string, unknown>[] | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (rows ?? []).map((row): [string, unknown] => [String(row['id']), row['body']]),
  );

describe('content.peek (PLAN-012 S4b)', () => {
  it('returns the parent’s rows without storing, paging in or hydrating them', async () => {
    const { hub, store, kept } = await itemWorld();
    const peek = await store.content.peek(id(1));
    expect(peek.state).toBe('ready');
    if (peek.state !== 'ready') return;
    expect(bodies(peek.rows['Note'])).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Note 12' });
    expect(hub.contentRequests).toEqual([[issueParent(id(1))]]);
    // Nothing kept: not in the pool, not in storage, not hydrated, not paged in.
    expect(store.pool.all('Note')).toEqual([]);
    expect(store.content.rows(id(1))['Note']).toEqual([]);
    expect(await kept.content(id(1))).toEqual({ hydrated: false, ids: [] });
    expect(store.content.state(id(1))).toBe('loading');
  });

  it('leaves the parent unhydrated: a later content packet for it is still dropped', async () => {
    const { hub, store, kept } = await itemWorld();
    await store.content.peek(id(1));
    hub.upsertNote(13, 1);
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    await eventually(async () => (await kept.lastSyncId()) >= hub.head);
    expect(store.pool.all('Note')).toEqual([]);
    expect(await kept.content(id(1))).toEqual({ hydrated: false, ids: [] });
  });

  it('answers a parent the server doesn’t show with no rows', async () => {
    const { hub, store } = await itemWorld();
    hub.hiddenParents.add(id(2));
    const peek = await store.content.peek(id(2));
    expect(peek).toEqual({ state: 'ready', rows: { Note: [] } });
  });

  it('is offline without asking when the connection is down', async () => {
    const { hub, store } = await itemWorld();
    hub.last.close();
    await until(() => store.connection === 'offline');
    expect(await store.content.peek(id(1))).toEqual({ state: 'offline' });
    expect(hub.contentRequests).toEqual([]);
  });

  it('fails when the request fails while online, and stores nothing', async () => {
    const { hub, store, kept } = await itemWorld();
    hub.contentStatus = 500;
    expect(await store.content.peek(id(1))).toEqual({ state: 'failed' });
    hub.contentStatus = 200;
    hub.failContent = 1;
    expect(await store.content.peek(id(1))).toEqual({ state: 'failed' });
    expect(await kept.content(id(1))).toEqual({ hydrated: false, ids: [] });
  });

  it('reads a deleted and an archived issue’s content, which the replica no longer holds (AC-26)', async () => {
    const hub = new FakeHub().withTeams();
    hub.addSquad(1);
    hub.join(USER_ID, 1);
    hub.putTask(110, 1, { creatorId: OTHER_USER });
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    hub.putTaskNote(601, 110);
    hub.putTaskNote(611, 111);
    const kept = keptMemoryStorage();
    const { store } = teamStore(hub, { connectStorage: kept.connect });
    stores.push(store);
    await store.start();
    await until(() => teamView(store).tasks[id(111)] !== undefined);
    hub.deleteTask(110);
    hub.archiveTask(111);
    await until(() => Object.keys(teamView(store).tasks).length === 0);

    for (const [task, note] of [
      [110, 601],
      [111, 611],
    ] as const) {
      const peek = await store.content.peek(id(task));
      expect(peek.state).toBe('ready');
      if (peek.state !== 'ready') return;
      expect((peek.rows['TaskNote'] ?? []).map((row) => row.id)).toEqual([id(note)]);
    }
    // Still not in the replica, and nothing of the answers was kept.
    expect(teamView(store)).toEqual({ tasks: {}, parts: {}, notes: {} });
    expect(await kept.stored('TaskNote')).toEqual([]);
  });
});
