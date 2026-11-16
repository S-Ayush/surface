// SPEC-011 §5.4, Q11; PLAN-011 S7: the content cache. At most 2,000 hydrated issues per replica,
// the least recently opened evicted first, never one open in a tab (its shared content lock),
// rows and mark together, and nothing evicted where Web Locks are missing.
import 'fake-indexeddb/auto';
import { computeSchemaHash, issueParent } from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_CACHE_LIMIT } from '../src/content.js';
import { contentLockName } from '../src/locks.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore, SyncStoreOptions } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, idle, keptMemoryStorage, liveStore, until } from './support/live.js';
import { FakeLocks } from './support/locks.js';
import { CONTENT_TEST_MODELS, USER_ID, id } from './support/models.js';
import { uniqueName } from './support/storage.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const NAMES = CONTENT_TEST_MODELS.map((model) => model.name);
const REFS = [{ model: 'Note', field: 'itemId', parent: 'DebugItem' }];

/** Items 1–4, each with one note (`10 * n + 1`). */
function itemHub(): FakeHub {
  const hub = new FakeHub();
  hub.schemaHash = computeSchemaHash(CONTENT_TEST_MODELS);
  for (const n of [1, 2, 3, 4]) {
    hub.upsert(n);
    hub.upsertNote(10 * n + 1, n);
  }
  return hub;
}

/** A clock that moves one ms each time it is read, so every open is later than the last. */
function steppingClock() {
  let now = 1_000;
  return () => (now += 1);
}

async function memoryTab(hub: FakeHub, options: Partial<SyncStoreOptions> = {}) {
  const kept = keptMemoryStorage();
  const { store } = liveStore(hub, {
    models: CONTENT_TEST_MODELS,
    connectStorage: kept.connect,
    clock: steppingClock(),
    ...options,
  });
  stores.push(store);
  await store.start();
  await until(() => store.connection === 'online');
  return { store, kept };
}

/** Open an item, wait for its content, and close it again. */
async function visit(store: SyncStore, n: number): Promise<void> {
  const handle = store.content.open(id(n));
  expect(await handle.ready).toBe('ready');
  handle.release();
}

const noteIds = (store: SyncStore) =>
  store.pool
    .all('Note')
    .map((note) => note.id)
    .sort();

describe('eviction by last opened (Q11)', () => {
  it('evicts the least recently opened issue past the limit, rows and mark together', async () => {
    const hub = itemHub();
    const { store, kept } = await memoryTab(hub, { contentCacheLimit: 2 });
    await visit(store, 1);
    await visit(store, 2);
    // Opened again: 2 is now the least recently opened.
    await visit(store, 1);
    await visit(store, 3);
    await eventually(async () => (await kept.hydrated()).length === 2);
    expect(await kept.hydrated()).toEqual([id(1), id(3)]);
    expect(await kept.content(id(2))).toEqual({ hydrated: false, ids: [] });
    // Paged in here but closed: it leaves this tab's memory too.
    expect(noteIds(store)).toEqual([id(11), id(31)]);
  });

  it('fetches an evicted issue again when it is opened', async () => {
    const hub = itemHub();
    const { store, kept } = await memoryTab(hub, { contentCacheLimit: 1 });
    await visit(store, 1);
    await visit(store, 2);
    await eventually(async () => (await kept.hydrated()).length === 1);
    hub.upsertNote(12, 1, 'Written while evicted');
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    await visit(store, 1);
    expect(hub.contentRequests).toEqual([
      [issueParent(id(1))],
      [issueParent(id(2))],
      [issueParent(id(1))],
    ]);
    expect(store.content.rows(id(1))['Note']?.map((note) => note['body'])).toEqual([
      'Note 11',
      'Written while evicted',
    ]);
  });

  it('never evicts an issue open in this tab', async () => {
    const hub = itemHub();
    const { store, kept } = await memoryTab(hub, { contentCacheLimit: 1 });
    const first = store.content.open(id(1));
    expect(await first.ready).toBe('ready');
    await visit(store, 2);
    await visit(store, 3);
    await eventually(async () => (await kept.hydrated()).length === 1);
    // 1 is the least recently opened, but open: 2 and 3 went instead.
    expect(await kept.hydrated()).toEqual([id(1)]);
    expect(store.content.rows(id(1))['Note']).toHaveLength(1);
    first.release();
  });

  it(`keeps at most ${String(CONTENT_CACHE_LIMIT)} hydrated issues by default`, async () => {
    const hub = itemHub();
    const { store, kept } = await memoryTab(hub);
    // Each new item's I packet hydrates it (§5.3 step 5), at "never opened" (0).
    for (let n = 5; n < 5 + CONTENT_CACHE_LIMIT + 1; n += 1) hub.upsert(n);
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    await eventually(async () => (await kept.hydrated()).length === CONTENT_CACHE_LIMIT, 20_000);
    // The tie on 0 goes by id: item 5 is the one evicted.
    expect(await kept.hydrated()).not.toContain(id(5));
    expect(await kept.hydrated()).toContain(id(6));
  }, 30_000);
});

describe('several tabs on one replica (§5.4)', () => {
  /** Two tabs sharing an IndexedDB replica, with Web Locks (`FakeLocks`) unless `locks: null`. */
  async function sharedTabs(hub: FakeHub, withLocks = true) {
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    // One clock for both tabs, so their opens are ordered.
    const clock = steppingClock();
    const connect: StorageConnector = (name, models, content) =>
      IndexedDbStorage.open(name, models, content);
    const tab = async (name: string) => {
      const { store } = liveStore(hub, {
        models: CONTENT_TEST_MODELS,
        workspaceId,
        connectStorage: connect,
        locks: withLocks ? locks.forTab(name) : null,
        clock,
        contentCacheLimit: 1,
      });
      stores.push(store);
      await store.start();
      await until(() => store.connection === 'online');
      return store;
    };
    const replica = `surface-${workspaceId}-${USER_ID}`;
    const hydrated = async () => {
      const storage = await IndexedDbStorage.open(replica, NAMES, REFS);
      try {
        return [...(await storage.readHydrated())].sort();
      } finally {
        await storage.close();
      }
    };
    return { a: await tab('a'), b: await tab('b'), locks, replica, hydrated };
  }

  it('holds an open issue’s content lock shared, and lets it go on release', async () => {
    const hub = itemHub();
    const { a, locks, replica } = await sharedTabs(hub);
    const handle = a.content.open(id(1));
    await handle.ready;
    expect(locks.holders(contentLockName(replica, id(1)))).toEqual([{ tab: 'a', mode: 'shared' }]);
    handle.release();
    await eventually(() => locks.holders(contentLockName(replica, id(1))).length === 0);
  });

  it('skips an issue another tab has open: its lock is held', async () => {
    const hub = itemHub();
    const { a, b, hydrated } = await sharedTabs(hub);
    const open = b.content.open(id(1));
    expect(await open.ready).toBe('ready');
    // Tab a hydrates 2: two hydrated, limit 1. The oldest, 1, is open in tab b.
    await visit(a, 2);
    await eventually(async () => (await hydrated()).length === 1);
    expect(await hydrated()).toEqual([id(1)]);
    expect(b.content.rows(id(1))['Note']).toHaveLength(1);
    open.release();
  });

  it('evicts nothing without Web Locks: another tab may have an issue open unseen', async () => {
    const hub = itemHub();
    const { a, hydrated } = await sharedTabs(hub, false);
    await visit(a, 1);
    await visit(a, 2);
    await visit(a, 3);
    await idle();
    expect(await hydrated()).toEqual([id(1), id(2), id(3)]);
  });
});
