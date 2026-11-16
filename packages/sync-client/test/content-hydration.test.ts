// SPEC-011 §5.3, §5.4, AC-9, E15, E17, E18, E23, E24, E25; PLAN-011 S5b: content hydration
// against the fake hub's `GET /sync/content`. Content rows reach a tab only for parents it opened
// (paged in), and storage keeps them only for hydrated parents.
import {
  CONTENT_PATH,
  computeSchemaHash,
  issueParent,
  type ContentFrame,
} from '@surface/sync-protocol';
import { reaction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchContent } from '../src/content.js';
import { ObjectPool } from '../src/pool.js';
import type { SocketFactory } from '../src/socket.js';
import { BACKOFF_MAX_MS, backoffDelay } from '../src/socket.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import {
  eventually,
  idle,
  keptMemoryStorage,
  liveStore,
  teamStore,
  teamView,
  until,
} from './support/live.js';
import { CONTENT_TEST_MODELS, OTHER_USER, USER_ID, id } from './support/models.js';
import { ndjsonResponse } from './support/server.js';
import { uniqueName } from './support/storage.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const CONTENT_HASH = computeSchemaHash(CONTENT_TEST_MODELS);

/** Items 1 (notes 11, 12) and 2 (note 21), never opened. */
function itemHub(): FakeHub {
  const hub = new FakeHub();
  hub.schemaHash = CONTENT_HASH;
  hub.upsert(1);
  hub.upsert(2);
  hub.upsertNote(11, 1);
  hub.upsertNote(12, 1);
  hub.upsertNote(21, 2);
  return hub;
}

async function itemWorld(hub = itemHub(), connect?: StorageConnector, workspaceId?: string) {
  const kept = keptMemoryStorage();
  const { store, timers } = liveStore(hub, {
    models: CONTENT_TEST_MODELS,
    connectStorage: connect ?? kept.connect,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
  stores.push(store);
  await store.start();
  await until(() => store.connection === 'online');
  /** Every packet sent so far is applied, and stored. */
  const settled = async () => {
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    if (connect === undefined) await eventually(async () => (await kept.lastSyncId()) >= hub.head);
  };
  return { hub, store, kept, timers, settled };
}

/** An item's notes in the store's memory: id → body. */
function notes(store: SyncStore, item: number): Record<string, unknown> {
  const rows = store.content.rows(id(item))['Note'] ?? [];
  return Object.fromEntries(rows.map((row) => [row.id, row['body']]));
}

describe('opening an item (SPEC-011 §5.3, §5.4)', () => {
  it('fetches its content, stores it hydrated and pages it in', async () => {
    const { hub, store, kept } = await itemWorld();
    expect(notes(store, 1)).toEqual({});
    const handle = store.content.open(id(1));
    expect(store.content.state(id(1))).toBe('loading');
    expect(await handle.ready).toBe('ready');
    expect(notes(store, 1)).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Note 12' });
    expect(hub.contentRequests).toEqual([[issueParent(id(1))]]);
    await eventually(async () => (await kept.content(id(1))).hydrated);
    expect(await kept.content(id(1))).toEqual({ hydrated: true, ids: [id(11), id(12)] });
    // Item 2 stays unloaded.
    expect(notes(store, 2)).toEqual({});
    expect(await kept.content(id(2))).toEqual({ hydrated: false, ids: [] });
  });

  it('keeps an open item live: content I, U and D packets apply', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    await store.content.open(id(1)).ready;
    hub.upsertNote(13, 1);
    hub.upsertNote(12, 1, 'Edited');
    hub.removeNote(11);
    await settled();
    expect(notes(store, 1)).toEqual({ [id(12)]: 'Edited', [id(13)]: 'Note 13' });
    expect(await kept.content(id(1))).toEqual({ hydrated: true, ids: [id(12), id(13)] });
  });

  it('drops content I and U packets of an item no tab hydrated, in memory and storage', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    hub.upsertNote(22, 2);
    hub.upsertNote(21, 2, 'Edited');
    await settled();
    expect(notes(store, 2)).toEqual({});
    expect(store.pool.all('Note')).toEqual([]);
    expect(await kept.content(id(2))).toEqual({ hydrated: false, ids: [] });
  });

  it('hydrates an item its I packet inserts: its content is kept from the start (§5.3 step 5)', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    hub.upsert(3);
    hub.upsertNote(31, 3);
    await settled();
    expect(await kept.content(id(3))).toEqual({ hydrated: true, ids: [id(31)] });
    // Opening it pages it in from storage: no request.
    expect(await store.content.open(id(3)).ready).toBe('ready');
    expect(notes(store, 3)).toEqual({ [id(31)]: 'Note 31' });
    expect(hub.contentRequests).toEqual([]);
  });

  it('pages an item opened before its I packet straight into memory', async () => {
    const { hub, store } = await itemWorld();
    const handle = store.content.open(id(4));
    // The replica doesn't hold it: nothing to load, and nothing to ask the server.
    expect(await handle.ready).toBe('ready');
    hub.upsert(4);
    hub.upsertNote(41, 4);
    await until(() => notes(store, 4)[id(41)] !== undefined);
    expect(store.content.state(id(4))).toBe('ready');
    // Its I hydrated it: no request.
    expect(hub.contentRequests).toEqual([]);
  });
});

describe('buffering while a request is in flight (§5.3 steps 1–3)', () => {
  it('replays packets above the answer’s lastSyncId on top of it (E17)', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    hub.holdContent = true;
    const handle = store.content.open(id(1));
    await eventually(() => hub.contentRequests.length === 1);
    // Committed after the snapshot, delivered before the answer.
    hub.upsertNote(12, 1, 'Edited');
    hub.upsertNote(13, 1);
    await settled();
    expect(notes(store, 1)).toEqual({});
    hub.releaseContent();
    expect(await handle.ready).toBe('ready');
    expect(notes(store, 1)).toEqual({
      [id(11)]: 'Note 11',
      [id(12)]: 'Edited',
      [id(13)]: 'Note 13',
    });
    await eventually(async () => (await kept.content(id(1))).ids.length === 3);
    // A fresh fetch agrees with what was stored and paged in.
    const fresh = await store.content.open(id(1)).ready;
    expect(fresh).toBe('ready');
    const meta = await kept.kept.storage?.readMeta();
    const stored = meta && (await kept.kept.storage?.readContent(meta.generation, id(1)));
    const bodies = Object.fromEntries(
      (stored?.records ?? []).map((r) => [r.row.id, r.row['body']]),
    );
    expect(bodies).toEqual(notes(store, 1));
  });

  it('stores a content D as a tombstone, so an older answer can’t bring the row back (E25)', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    hub.holdContent = true;
    const handle = store.content.open(id(2));
    await eventually(() => hub.contentRequests.length === 1);
    hub.removeNote(21); // a D for an item not hydrated yet: applied everywhere
    await settled();
    hub.releaseContent(); // the snapshot still holds note 21, at a lower id
    expect(await handle.ready).toBe('ready');
    expect(notes(store, 2)).toEqual({});
    await eventually(async () => (await kept.content(id(2))).hydrated);
    expect(await kept.content(id(2))).toEqual({ hydrated: true, ids: [] });
  });

  it('skips an item purged while its request was in flight (E23)', async () => {
    const { hub, store, kept, settled } = await itemWorld();
    hub.holdContent = true;
    const handle = store.content.open(id(1));
    await eventually(() => hub.contentRequests.length === 1);
    hub.purge(1);
    await settled();
    hub.releaseContent();
    await handle.ready;
    await idle();
    expect(store.pool.all('Note')).toEqual([]);
    expect(await kept.content(id(1))).toEqual({ hydrated: false, ids: [] });
    expect(await kept.hydrated()).toEqual([]);
  });

  it('shows an item the server doesn’t show as ready and empty, and stores nothing', async () => {
    const hub = itemHub();
    hub.hiddenParents.add(id(2));
    const { store, kept } = await itemWorld(hub);
    expect(await store.content.open(id(2)).ready).toBe('ready');
    expect(notes(store, 2)).toEqual({});
    await idle();
    expect(await kept.content(id(2))).toEqual({ hydrated: false, ids: [] });
  });

  it.each([
    ['a network error', (hub: FakeHub) => (hub.failContent = 1)],
    ['a truncated answer (AC-9)', (hub: FakeHub) => (hub.truncateContent = true)],
    ['a 500', (hub: FakeHub) => (hub.contentStatus = 500)],
  ])('drops the buffer and mark on %s; the next open retries', async (_, fail) => {
    const { hub, store, kept, settled } = await itemWorld();
    fail(hub);
    const first = store.content.open(id(1));
    hub.upsertNote(13, 1);
    expect(await first.ready).toBe('loading');
    await settled();
    expect(notes(store, 1)).toEqual({});
    expect(await kept.content(id(1))).toEqual({ hydrated: false, ids: [] });
    first.release();
    hub.truncateContent = false;
    hub.contentStatus = 200;
    expect(await store.content.open(id(1)).ready).toBe('ready');
    expect(Object.keys(notes(store, 1))).toEqual([id(11), id(12), id(13)]);
  });
});

describe('a failed load (§5.3 step 3)', () => {
  it('retries an open item on a growing backoff, up to the cap, until it loads', async () => {
    const { hub, store, timers } = await itemWorld();
    hub.failContent = 6;
    const handle = store.content.open(id(1));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const delay = backoffDelay(attempt, 0);
      await eventually(() => hub.failContent === 5 - attempt && timers.pending.includes(delay));
      timers.advance(delay);
    }
    expect(backoffDelay(5, 0)).toBe(BACKOFF_MAX_MS / 2);
    await until(() => store.content.state(id(1)) === 'ready');
    expect(notes(store, 1)).toEqual({ [id(11)]: 'Note 11', [id(12)]: 'Note 12' });
    expect(hub.contentRequests).toEqual([[issueParent(id(1))]]);
    handle.release();
  });

  it('cancels the pending retry when the item is released', async () => {
    const { hub, store, timers } = await itemWorld();
    hub.failContent = 1;
    const handle = store.content.open(id(1));
    const delay = backoffDelay(0, 0);
    await eventually(() => hub.failContent === 0 && timers.pending.includes(delay));
    handle.release();
    expect(timers.pending).not.toContain(delay);
    timers.advance(delay);
    await idle();
    expect(hub.contentRequests).toEqual([]);
  });

  it('loads an open item that couldn’t load offline once the connection is back', async () => {
    const { hub, store, timers } = await itemWorld();
    hub.last.close();
    await until(() => store.connection === 'offline');
    const handle = store.content.open(id(2));
    expect(await handle.ready).toBe('offline');
    expect(hub.contentRequests).toEqual([]);
    await eventually(() => {
      if (store.connection === 'offline') timers.runNext();
      return store.connection === 'online';
    });
    await until(() => store.content.state(id(2)) === 'ready');
    expect(notes(store, 2)).toEqual({ [id(21)]: 'Note 21' });
    expect(hub.contentRequests).toEqual([[issueParent(id(2))]]);
    handle.release();
  });
});

describe('offline (E11)', () => {
  it('shows an item never loaded as offline while the socket keeps retrying, then loads it', async () => {
    const hub = itemHub();
    let down = false;
    // While down, every connection attempt fails before it opens.
    const socket: SocketFactory = (url, handlers) => {
      if (!down) return hub.socket(url, handlers);
      queueMicrotask(() => handlers.onClose(1006));
      return { send: () => undefined, close: () => undefined };
    };
    const kept = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      models: CONTENT_TEST_MODELS,
      connectStorage: kept.connect,
      connection: { socket },
    });
    stores.push(store);
    await store.start();
    await until(() => store.connection === 'online');
    await store.content.open(id(1)).ready;
    down = true;
    hub.failContent = 100; // the network is down for HTTP too
    hub.last.close();
    await until(() => store.connection === 'offline');
    const handle = store.content.open(id(2));
    // It may show loading while the replica is read; once that finds nothing, offline.
    expect(await handle.ready).toBe('offline');
    const states: string[] = [];
    const stop = reaction(
      () => store.content.state(id(2)),
      (state) => states.push(state),
      { fireImmediately: true },
    );
    // A hydrated item still opens from the replica.
    expect(await store.content.open(id(1)).ready).toBe('ready');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.runNext();
      await until(() => store.connection === 'offline');
      await idle(5);
    }
    expect(new Set(states)).toEqual(new Set(['offline']));
    down = false;
    hub.failContent = 0;
    await eventually(() => {
      if (store.connection === 'offline') timers.runNext();
      return store.connection === 'online';
    });
    await until(() => store.content.state(id(2)) === 'ready');
    expect(notes(store, 2)).toEqual({ [id(21)]: 'Note 21' });
    stop();
    handle.release();
  });
});

describe('fetchContent', () => {
  it('drops a row whose parent the answer’s meta doesn’t name (E15)', async () => {
    const pool = new ObjectPool(CONTENT_TEST_MODELS);
    const frames: ContentFrame[] = [
      { t: 'meta', lastSyncId: 7, parents: [issueParent(id(1))], rows: 2 },
      { t: 'row', m: 'Note', d: { id: id(11), itemId: id(1), body: 'a' } },
      { t: 'row', m: 'Note', d: { id: id(21), itemId: id(2), body: 'b' } },
      { t: 'end', rows: 2 },
    ];
    const urls: string[] = [];
    const answer = await fetchContent({
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(ndjsonResponse(frames));
      },
      baseUrl: 'http://surface.test',
      userId: USER_ID,
      schemaHash: CONTENT_HASH,
      parents: [id(1), id(2)],
      pool,
      models: [{ model: 'Note', field: 'itemId', parent: 'DebugItem' }],
    });
    expect(answer.lastSyncId).toBe(7);
    expect(answer.parents).toEqual([id(1)]);
    expect(answer.rows.map((r) => r.row.id)).toEqual([id(11)]);
    expect(new URL(urls[0] ?? '').pathname).toBe(CONTENT_PATH);
  });
});

describe('start and resync (§5.3 step 7, §5.4)', () => {
  it('clears every hydration mark on resync, and loads open items again', async () => {
    const { hub, store, kept } = await itemWorld();
    await store.content.open(id(1)).ready;
    const other = store.content.open(id(2));
    await other.ready;
    other.release();
    await eventually(async () => (await kept.hydrated()).length === 2);
    await store.resync();
    await until(() => store.content.state(id(1)) === 'ready');
    expect(hub.contentRequests).toHaveLength(3);
    await eventually(async () => (await kept.hydrated()).length === 1);
    expect(await kept.hydrated()).toEqual([id(1)]);
    expect(notes(store, 2)).toEqual({});
    expect(Object.keys(notes(store, 1))).toEqual([id(11), id(12)]);
  });

  it('starts warm without paging content in, and pages an item in from storage when opened', async () => {
    const workspaceId = uniqueName('ws');
    const connect: StorageConnector = (name, models, content) =>
      IndexedDbStorage.open(name, models, content);
    const hub = itemHub();
    const first = await itemWorld(hub, connect, workspaceId);
    await first.store.content.open(id(1)).ready;
    await first.settled();
    await first.store.close();
    const second = await itemWorld(hub, connect, workspaceId);
    expect(second.store.pool.all('Note')).toEqual([]);
    expect(await second.store.content.open(id(1)).ready).toBe('ready');
    expect(Object.keys(notes(second.store, 1))).toEqual([id(11), id(12)]);
    expect(hub.contentRequests).toHaveLength(1);
  });
});

describe('issues and team subscriptions (§5.3 step 5, E24)', () => {
  /** Squad 1 (member) with task 110 and its note 601; squad 3 public, not followed. */
  async function teamWorld() {
    const hub = new FakeHub().withTeams();
    hub.addSquad(1);
    hub.addSquad(3);
    hub.join(USER_ID, 1);
    hub.putTask(110, 1, { creatorId: OTHER_USER });
    hub.putTaskNote(601, 110);
    const kept = keptMemoryStorage();
    const { store } = teamStore(hub, { connectStorage: kept.connect });
    stores.push(store);
    await store.start();
    await until(() => store.connection === 'online' && store.followedTeams.has(id(1)));
    const settled = async () => {
      await until(() => (store.position?.lastSyncId ?? 0) >= hub.last.sent);
      await eventually(async () => (await kept.lastSyncId()) >= hub.last.sent);
    };
    return { hub, store, kept, settled };
  }

  it('hydrates an issue its I packet inserts when its team is subscribed', async () => {
    const { hub, store, kept, settled } = await teamWorld();
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    hub.putTaskNote(611, 111);
    await settled();
    expect(await kept.content(id(111))).toEqual({ hydrated: true, ids: [id(611)] });
    expect(await store.content.open(id(111)).ready).toBe('ready');
    expect(teamView(store).notes).toEqual({ [id(611)]: id(111) });
    expect(hub.contentRequests).toEqual([]);
  });

  it('doesn’t hydrate an issue held only through a user: group (§5.3 step 5)', async () => {
    const { hub, kept, settled } = await teamWorld();
    hub.putTask(130, 3, { assigneeId: USER_ID });
    await settled();
    expect(await kept.stored('Task')).toContain(id(130));
    expect(await kept.content(id(130))).toEqual({ hydrated: false, ids: [] });
  });

  it('keeps an issue’s content across the D+U pair of a group change (E24)', async () => {
    const { hub, store, kept, settled } = await teamWorld();
    expect(await store.content.open(id(110)).ready).toBe('ready');
    expect(teamView(store).notes).toEqual({ [id(601)]: id(110) });
    hub.putTask(110, 1, { assigneeId: USER_ID });
    await settled();
    expect(teamView(store).notes).toEqual({ [id(601)]: id(110) });
    expect(await kept.content(id(110))).toEqual({ hydrated: true, ids: [id(601)] });
    hub.putTaskNote(602, 110);
    await settled();
    expect(Object.keys(teamView(store).notes)).toEqual([id(601), id(602)]);
  });

  it('drops an issue’s content and mark when a purge leaves it absent', async () => {
    const { hub, store, kept, settled } = await teamWorld();
    await store.content.open(id(110)).ready;
    await eventually(async () => (await kept.content(id(110))).hydrated);
    hub.purgeTask(110);
    await settled();
    expect(teamView(store).notes).toEqual({});
    expect(await kept.content(id(110))).toEqual({ hydrated: false, ids: [] });
  });

  it.each([
    ['deleted and restored (V)', (hub: FakeHub) => hub.deleteTask(110), 'V' as const],
    ['deleted and restored (U)', (hub: FakeHub) => hub.deleteTask(110), 'U' as const],
    ['archived and restored', (hub: FakeHub) => hub.archiveTask(110), 'V' as const],
  ])('loads an issue kept open again once it is back: %s (PLAN-015 S2)', async (_, remove, as) => {
    const { hub, store, settled } = await teamWorld();
    const handle = store.content.open(id(110));
    expect(await handle.ready).toBe('ready');
    remove(hub);
    await settled();
    expect(teamView(store).notes).toEqual({});
    // Written while it was gone: only a fresh load brings it.
    hub.putTaskNote(602, 110);
    hub.restoreTask(110, as);
    await settled();
    await until(() => Object.keys(teamView(store).notes).length === 2);
    expect(store.content.state(id(110))).toBe('ready');
    expect(Object.keys(teamView(store).notes)).toEqual([id(601), id(602)]);
    handle.release();
  });

  it('subscribes the team of an issue it opens, then fetches the content', async () => {
    const { hub, store } = await teamWorld();
    hub.putTask(130, 3, { assigneeId: USER_ID });
    hub.putTaskNote(631, 130);
    await until(() => teamView(store).tasks[id(130)] !== undefined);
    expect(store.followedTeams.has(id(3))).toBe(false);
    expect(await store.content.open(id(130)).ready).toBe('ready');
    expect(store.followedTeams.has(id(3))).toBe(true);
    expect(teamView(store).notes).toEqual({ [id(631)]: id(130) });
  });
});
