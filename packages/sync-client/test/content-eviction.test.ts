// SPEC-011 §5.4, Q11; PLAN-011 S7: the content cache. At most 2,000 hydrated issues per replica,
// the least recently opened evicted first, never one open in a tab (its shared content lock),
// rows and mark together, and nothing evicted where Web Locks are missing.
import 'fake-indexeddb/auto';
import { computeSchemaHash, issueParent } from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_CACHE_LIMIT } from '../src/content.js';
import { contentLockName, type ReplicaLocks } from '../src/locks.js';
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

/** Stops tab a's next eviction once armed, until opened: to land an open in the middle of it. */
class Gate {
  #armed = false;
  hit = false;
  #open: () => void = () => undefined;
  #wait: Promise<void> = Promise.resolve();

  arm(): void {
    this.#armed = true;
    this.#wait = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  open(): void {
    this.#open();
  }

  /** Where tab a's eviction passes: waits there once, when armed. */
  async pass(): Promise<void> {
    if (!this.#armed) return;
    this.#armed = false;
    this.hit = true;
    await this.#wait;
  }
}

/** Storage whose `evictContent` waits at `gate` first: the eviction is under way, lock held. */
function gatedStorage(gate: Gate): StorageConnector {
  return async (name, models, content) => {
    const storage = await IndexedDbStorage.open(name, models, content);
    return new Proxy(storage, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        if (key !== 'evictContent') {
          return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await gate.pass();
          return Reflect.apply(value, target, args);
        };
      },
    });
  };
}

/** Locks whose `ifAvailable` grants (eviction's) wait at `gate` while held. */
function gatedLocks(inner: ReplicaLocks, gate: Gate): ReplicaLocks {
  return {
    request(name, options, callback) {
      return inner.request(name, options, async (lock) => {
        if (options.ifAvailable === true && lock !== null) await gate.pass();
        return callback(lock);
      });
    },
  };
}

describe('several tabs on one replica (§5.4)', () => {
  /**
   * Two tabs sharing an IndexedDB replica, with Web Locks (`FakeLocks`) unless `withLocks` is
   * false. `gate` stops tab a's next eviction at its storage write or once it holds a lock.
   */
  async function sharedTabs(
    hub: FakeHub,
    withLocks = true,
    gate?: { at: 'storage' | 'lock'; gate: Gate },
  ) {
    const workspaceId = uniqueName('ws');
    const locks = new FakeLocks();
    // One clock for both tabs, so their opens are ordered.
    const clock = steppingClock();
    const connect: StorageConnector = (name, models, content) =>
      IndexedDbStorage.open(name, models, content);
    const tab = async (name: string) => {
      const gated = name === 'a' ? gate : undefined;
      const tabLocks =
        gated?.at === 'lock' ? gatedLocks(locks.forTab(name), gated.gate) : locks.forTab(name);
      const { store } = liveStore(hub, {
        models: CONTENT_TEST_MODELS,
        workspaceId,
        connectStorage: gated?.at === 'storage' ? gatedStorage(gated.gate) : connect,
        locks: withLocks ? tabLocks : null,
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

  it('makes a tab that opens an issue being evicted wait, then fetch it again', async () => {
    const hub = itemHub();
    const gate = new Gate();
    const { a, b, locks, replica } = await sharedTabs(hub, true, { at: 'storage', gate });
    const name = contentLockName(replica, id(1));
    await visit(a, 1);
    gate.arm();
    // Tab a hydrates 2, past the limit (1): it evicts 1, and stops as it removes it.
    await visit(a, 2);
    await eventually(() => gate.hit);
    expect(locks.holders(name)).toEqual([{ tab: 'a', mode: 'exclusive' }]);
    const before = hub.contentRequests.length;
    const one = b.content.open(id(1));
    let settled = false;
    void one.ready.then(() => {
      settled = true;
    });
    await idle();
    expect(settled).toBe(false);
    expect(locks.waiting(name)).toBe(1);
    gate.open();
    expect(await one.ready).toBe('ready');
    // Evicted while it waited: fetched again, not read from a half-removed replica.
    expect(hub.contentRequests.slice(before)).toEqual([[issueParent(id(1))]]);
    expect(b.content.rows(id(1))['Note']?.map((note) => note.id)).toEqual([id(11)]);
    one.release();
  });

  it('keeps an issue this tab opens while its eviction holds the issue’s lock', async () => {
    const hub = itemHub();
    const gate = new Gate();
    const { a, hydrated } = await sharedTabs(hub, true, { at: 'lock', gate });
    await visit(a, 1);
    gate.arm();
    // Hydrating 2 evicts 1: the eviction takes 1's lock and stops there.
    await visit(a, 2);
    await eventually(() => gate.hit);
    const before = hub.contentRequests.length;
    const one = a.content.open(id(1));
    gate.open();
    expect(await one.ready).toBe('ready');
    // Open before the eviction looked again: kept, and read from the replica.
    expect(hub.contentRequests).toHaveLength(before);
    expect(a.content.rows(id(1))['Note']?.map((note) => note.id)).toEqual([id(11)]);
    await eventually(async () => (await hydrated()).length === 1);
    expect(await hydrated()).toEqual([id(1)]);
    one.release();
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
