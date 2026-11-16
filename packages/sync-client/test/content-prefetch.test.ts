// SPEC-011 §5.4, D16; PLAN-011 S7: content prefetch. A list's first 50 rows once they stay 200 ms,
// an issue under the pointer after 150 ms; at most 50 parents per request and 4 requests in
// flight; hydrated parents not asked for; parents an answer left out for its size asked again.
import { computeSchemaHash, issueParent, type ContentParent } from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { leftOutParents } from '../src/content.js';
import {
  PREFETCH_HOVER_MS,
  PREFETCH_LIST_DEBOUNCE_MS,
  PREFETCH_LIST_ROWS,
} from '../src/prefetch.js';
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

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** Items 1…`count`, item n with note `1000 + n`. */
function itemHub(count = 4): FakeHub {
  const hub = new FakeHub();
  hub.schemaHash = computeSchemaHash(CONTENT_TEST_MODELS);
  for (let n = 1; n <= count; n += 1) {
    hub.upsert(n);
    hub.upsertNote(1000 + n, n);
  }
  return hub;
}

async function itemWorld(hub = itemHub()) {
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

const ids = (...ns: number[]) => ns.map(id);
const asked = (...ns: number[]): ContentParent[] => ns.map((n) => issueParent(id(n)));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('what is prefetched (§5.4)', () => {
  it('stores the content without paging it in; opening it then reads the replica', async () => {
    const { hub, store, kept } = await itemWorld();
    store.content.prefetch(ids(1, 2));
    await eventually(async () => (await kept.hydrated()).length === 2);
    expect(hub.contentRequests).toEqual([asked(1, 2)]);
    expect(await kept.content(id(1))).toEqual({ hydrated: true, ids: [id(1001)] });
    expect(store.pool.all('Note')).toEqual([]);
    expect(await store.content.open(id(1)).ready).toBe('ready');
    expect(store.content.rows(id(1))['Note']?.map((n) => n.id)).toEqual([id(1001)]);
    expect(hub.contentRequests).toHaveLength(1);
  });

  it('skips parents already hydrated, paged in, or not held', async () => {
    const { hub, store, kept } = await itemWorld();
    await store.content.open(id(1)).ready;
    // Item 5 has an I packet, which hydrates it (§5.3 step 5).
    hub.upsert(5);
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    await eventually(async () => (await kept.hydrated()).includes(id(5)));
    store.content.prefetch(ids(1, 2, 5, 9));
    await eventually(() => hub.contentRequests.length === 2);
    expect(hub.contentRequests[1]).toEqual(asked(2));
    store.content.prefetch(ids(2));
    await idle();
    expect(hub.contentRequests).toHaveLength(2);
  });

  it('keeps an update that arrives while the request is in flight (E17)', async () => {
    const { hub, store, kept } = await itemWorld();
    hub.holdContent = true;
    store.content.prefetch(ids(1));
    await eventually(() => hub.contentRequests.length === 1);
    hub.upsertNote(1001, 1, 'Edited meanwhile');
    await until(() => (store.position?.lastSyncId ?? 0) >= hub.head);
    hub.releaseContent();
    await eventually(async () => (await kept.content(id(1))).hydrated);
    expect(await store.content.open(id(1)).ready).toBe('ready');
    expect(store.content.rows(id(1))['Note']?.map((n) => n['body'])).toEqual(['Edited meanwhile']);
  });

  it('prefetches nothing offline', async () => {
    const { hub, store } = await itemWorld();
    hub.last.close();
    await until(() => store.connection === 'offline');
    store.content.prefetch(ids(1));
    await idle();
    expect(hub.contentRequests).toEqual([]);
  });

  it('prefetches only issues of followed teams (§5.7)', async () => {
    const hub = new FakeHub().withTeams();
    hub.addSquad(1);
    hub.addSquad(3);
    hub.join(USER_ID, 1);
    hub.putTask(110, 1, { creatorId: OTHER_USER });
    hub.putTask(130, 3, { assigneeId: USER_ID });
    const { store } = teamStore(hub, { connectStorage: keptMemoryStorage().connect });
    stores.push(store);
    await store.start();
    await until(() => store.connection === 'online' && store.followedTeams.has(id(1)));
    await until(() => teamView(store).tasks[id(130)] !== undefined);
    store.content.prefetch(ids(130, 110));
    await eventually(() => hub.contentRequests.length === 1);
    expect(hub.contentRequests).toEqual([asked(110)]);
    // Prefetch never subscribes a team on demand.
    expect(store.followedTeams.has(id(3))).toBe(false);
  });
});

describe('request limits (§5.4)', () => {
  it('asks for at most 50 parents per request, in the order given', async () => {
    const { hub, store, kept } = await itemWorld(itemHub(120));
    store.content.prefetch(ids(...range(1, 120)));
    await eventually(async () => (await kept.hydrated()).length === 120);
    expect(hub.contentRequests.map((r) => r.length)).toEqual([50, 50, 20]);
    expect(hub.contentRequests[0]?.[0]).toBe(issueParent(id(1)));
  });

  it('keeps at most 4 requests in flight', async () => {
    const { hub, store, kept } = await itemWorld(itemHub(250));
    hub.holdContent = true;
    store.content.prefetch(ids(...range(1, 250)));
    await eventually(() => hub.contentRequests.length === 4);
    await idle();
    expect(hub.contentRequests).toHaveLength(4);
    hub.holdContent = false;
    hub.releaseContent();
    await eventually(async () => (await kept.hydrated()).length === 250);
    expect(hub.contentRequests).toHaveLength(5);
  });
});

describe('answers cut by the size budget (D16)', () => {
  it('names as left out only the parents after the last one taken', () => {
    expect(leftOutParents(ids(1, 2, 3, 4), ids(1, 3))).toEqual(ids(4));
    expect(leftOutParents(ids(1, 2, 3), ids(1))).toEqual(ids(2, 3));
    // Missing before the last taken: unknown or invisible, not left out.
    expect(leftOutParents(ids(1, 2, 3), ids(3))).toEqual([]);
    // None taken: none visible (the first visible always comes).
    expect(leftOutParents(ids(1, 2), [])).toEqual([]);
  });

  it('asks again for the parents an answer left out, until each is stored', async () => {
    const hub = itemHub();
    hub.contentBudget = 1;
    const { store, kept } = await itemWorld(hub);
    store.content.prefetch(ids(1, 2, 3));
    await eventually(async () => (await kept.hydrated()).length === 3);
    expect(hub.contentRequests).toEqual([asked(1, 2, 3), asked(2, 3), asked(3)]);
  });

  it('doesn’t ask again for a parent the server doesn’t show', async () => {
    const hub = itemHub();
    hub.contentBudget = 1;
    hub.hiddenParents.add(id(2));
    const { store, kept } = await itemWorld(hub);
    store.content.prefetch(ids(1, 2, 3));
    await eventually(async () => (await kept.hydrated()).length === 2);
    await idle();
    expect(hub.contentRequests).toEqual([asked(1, 2, 3), asked(2, 3)]);
    expect(await kept.hydrated()).toEqual(ids(1, 3));
  });

  it('loads a parent opened while its prefetch left it out, instead of showing it empty', async () => {
    const hub = itemHub();
    hub.contentBudget = 1;
    const { store } = await itemWorld(hub);
    hub.holdContent = true;
    store.content.prefetch(ids(1, 2));
    await eventually(() => hub.contentRequests.length === 1);
    const handle = store.content.open(id(2));
    hub.holdContent = false;
    hub.releaseContent();
    expect(await handle.ready).toBe('ready');
    expect(store.content.rows(id(2))['Note']?.map((n) => n.id)).toEqual([id(1002)]);
    expect(hub.contentRequests).toEqual([asked(1, 2), asked(2)]);
    handle.release();
  });
});

describe('when views prefetch (§5.4)', () => {
  it('prefetches a list’s first 50 rows once they have stayed 200 ms', async () => {
    const { hub, store, timers, kept } = await itemWorld(itemHub(60));
    store.content.prefetchList('list', ids(3, 2, 1));
    timers.advance(PREFETCH_LIST_DEBOUNCE_MS - 1);
    // Scrolled on: the rows shown before are never fetched.
    store.content.prefetchList('list', ids(...range(1, 60)));
    timers.advance(PREFETCH_LIST_DEBOUNCE_MS - 1);
    await idle();
    expect(hub.contentRequests).toEqual([]);
    timers.advance(1);
    await eventually(async () => (await kept.hydrated()).length === PREFETCH_LIST_ROWS);
    expect(hub.contentRequests).toEqual([asked(...range(1, PREFETCH_LIST_ROWS))]);
  });

  it('cancels a list’s pending prefetch when it shows nothing', async () => {
    const { hub, store, timers } = await itemWorld();
    store.content.prefetchList('list', ids(1));
    store.content.prefetchList('list', []);
    timers.advance(PREFETCH_LIST_DEBOUNCE_MS);
    await idle();
    expect(hub.contentRequests).toEqual([]);
  });

  it('prefetches an issue the pointer rests on for 150 ms, and not one it only passes', async () => {
    const { hub, store, timers, kept } = await itemWorld();
    const passed = store.content.prefetchOnHover(id(1));
    timers.advance(PREFETCH_HOVER_MS - 1);
    passed();
    store.content.prefetchOnHover(id(2));
    timers.advance(PREFETCH_HOVER_MS);
    await eventually(async () => (await kept.hydrated()).length === 1);
    expect(hub.contentRequests).toEqual([asked(2)]);
  });
});
