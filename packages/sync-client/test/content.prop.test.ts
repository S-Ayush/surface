/**
 * The content property (sync property suite; SPEC-011 AC-8, E17, E18, E23, E24, E25; PLAN-011
 * S5b), on the fake hub's debug items and their notes: two tabs share one IndexedDB replica.
 * Note writes and deletes, item purges (whose note deletes are not logged), group changes (`D`+`U`),
 * new items, opens and releases in either tab, held and failed content answers, socket drops and
 * resyncs interleave, with prefetches (whose answers a size budget may cut, D16) and evictions
 * past a small cache limit (PLAN-011 S7). A tab may die mid-run, as it starts a storage call (between an answer and
 * what follows it, say); a new tab then warm-starts from the replica in its place. Once quiet,
 * every item each tab opens shows exactly the server's notes (a fresh fetch), the shared replica
 * stores exactly those for every hydrated item, and a tab started afterwards from the replica
 * alone shows the same.
 */
import 'fake-indexeddb/auto';
import { computeSchemaHash } from '@surface/sync-protocol';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { ContentHandle } from '../src/content.js';
import type { SocketFactory } from '../src/socket.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStorage } from '../src/storage/types.js';
import type { SyncStore } from '../src/store.js';
import { PROPERTY_SEED, propertyRuns, propertySeed } from './support/fc.js';
import type { HubConnection } from './support/hub.js';
import { FakeHub } from './support/hub.js';
import { eventually, idle, liveStore } from './support/live.js';
import { FakeLocks } from './support/locks.js';
import { CONTENT_TEST_MODELS, USER_ID, id } from './support/models.js';
import { uniqueName } from './support/storage.js';
import type { ManualTimers } from './support/timers.js';

const NAMES = CONTENT_TEST_MODELS.map((model) => model.name);
const REFS = [{ model: 'Note', field: 'itemId', parent: 'DebugItem' }];
/** Items 1–3; item 3 is created during the run. Note `10 * item + k`, k in 1–2. */
const ITEMS = [1, 2, 3] as const;
/** The item `settle` writes to: its `I` hydrates it. */
const PROBE = 9;
/** A small content cache, so opens, prefetches and `I` packets evict (SPEC-011 §5.4). */
const CACHE_LIMIT = 2;

type Tab = 0 | 1;
interface TabHandle {
  readonly name: string;
  readonly store: SyncStore;
  readonly life: Life;
  readonly timers: ManualTimers;
  readonly connections: HubConnection[];
  readonly handles: { readonly parent: string; readonly handle: ContentHandle }[];
}

/** A tab's storage calls, and its death (a crash: the store is never closed). */
interface Life {
  calls: number;
  /** Die as this storage call starts. */
  dieAt: number | undefined;
  dead: boolean;
  readonly storages: SyncStorage[];
  die(): void;
}

/** Parents evicted over all runs: the property must see evictions happen, not only allow them. */
let evictions = 0;

/** `storage`, whose calls never settle once the tab is dead: what it wrote before stays. */
function mortal(storage: SyncStorage, life: Life): SyncStorage {
  return new Proxy(storage, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        life.calls += 1;
        if (life.dieAt !== undefined && life.calls >= life.dieAt) life.die();
        if (life.dead) return new Promise(() => undefined);
        const result: unknown = Reflect.apply(value, target, args);
        if (key === 'evictContent' && result instanceof Promise) {
          result.then(
            (evicted: unknown) => {
              if (Array.isArray(evicted)) evictions += evicted.length;
            },
            () => undefined,
          );
        }
        return result;
      };
    },
  });
}

type Command =
  | { kind: 'note'; item: number; k: number; body: string }
  | { kind: 'drop'; item: number; k: number }
  | { kind: 'purge' | 'regroup'; item: number }
  | { kind: 'create' }
  | { kind: 'open'; tab: Tab; item: number }
  | { kind: 'prefetch'; tab: Tab; items: number[] }
  | { kind: 'budget' }
  | { kind: 'close'; tab: Tab }
  | { kind: 'hold' | 'release' | 'fail' }
  | { kind: 'drop-socket' | 'tick' | 'resync'; tab: Tab }
  | { kind: 'kill'; tab: Tab; after: number }
  | { kind: 'yield'; turns: number }
  | { kind: 'wait' };

const item = fc.constantFrom(...ITEMS);
const tab = fc.constantFrom<Tab>(0, 1);
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('note' as const),
      item,
      k: fc.constantFrom(1, 2),
      body: fc.constantFrom('A', 'B'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('drop' as const), item, k: fc.constantFrom(1, 2) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constantFrom('purge' as const, 'regroup' as const), item }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('create' as const) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('open' as const), tab, item }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('close' as const), tab }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('prefetch' as const),
      tab,
      items: fc.uniqueArray(item, { minLength: 1, maxLength: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('budget' as const) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom('hold' as const, 'release' as const, 'fail' as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom('drop-socket' as const, 'tick' as const, 'resync' as const),
      tab,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('yield' as const),
      turns: fc.integer({ min: 1, max: 5 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('wait' as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('kill' as const),
      tab,
      after: fc.integer({ min: 0, max: 4 }),
    }),
  },
);

/** The server's notes of item `n` (a fresh fetch): id → body; none for an item it doesn't hold. */
function serverNotes(hub: FakeHub, n: number): Record<string, unknown> {
  if (!hub.rows.has(id(n))) return {};
  return Object.fromEntries(
    [...hub.notes.values()]
      .filter((row) => row['itemId'] === id(n))
      .map((row) => [row.id, row['body']]),
  );
}

function shownNotes(store: SyncStore, n: number): Record<string, unknown> {
  const rows = store.content.rows(id(n))['Note'] ?? [];
  return Object.fromEntries(rows.map((row) => [row.id, row['body']]));
}

it('leaves every opened item, in each tab and the shared replica, equal to a fresh fetch', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { maxLength: 30 }), async (commands) => {
      const hub = new FakeHub();
      hub.schemaHash = computeSchemaHash(CONTENT_TEST_MODELS);
      hub.upsert(1);
      hub.upsert(2);
      hub.upsertNote(11, 1);
      hub.upsertNote(21, 2);
      let created = false;
      let purged = new Set<number>();

      const workspaceId = uniqueName('ws');
      const replica = `surface-${workspaceId}-${USER_ID}`;
      const locks = new FakeLocks();
      const all: TabHandle[] = [];
      let born = 0;
      const begin = async (name: string): Promise<TabHandle> => {
        const connections: HubConnection[] = [];
        const life: Life = {
          calls: 0,
          dieAt: undefined,
          dead: false,
          storages: [],
          die: () => {
            if (life.dead) return;
            life.dead = true;
            // The browser closes a dead tab's sockets, database connections and locks.
            for (const connection of connections) if (connection.isOpen) connection.close(1006);
            for (const storage of life.storages) storage.close().catch(() => undefined);
            locks.kill(name);
          },
        };
        const connect: StorageConnector = async (replicaName, models, content) => {
          const storage = await IndexedDbStorage.open(replicaName, models, content);
          life.storages.push(storage);
          return mortal(storage, life);
        };
        const socket: SocketFactory = (url, handlers) => {
          const client = hub.socket(url, handlers);
          const connection = hub.connections.at(-1);
          if (connection !== undefined) connections.push(connection);
          return client;
        };
        const { store, timers } = liveStore(hub, {
          models: CONTENT_TEST_MODELS,
          workspaceId,
          connectStorage: connect,
          locks: locks.forTab(name),
          contentCacheLimit: CACHE_LIMIT,
          connection: { socket },
        });
        const handle: TabHandle = { name, store, life, timers, connections, handles: [] };
        all.push(handle);
        await store.start();
        return handle;
      };
      /** A dead tab's place goes to a new one, warm-started from the replica. */
      const revive = async () => {
        for (const [index, t] of tabs.entries()) {
          if (t.life.dead) tabs[index] = await begin(`${t.name}-${String((born += 1))}`);
        }
      };
      const tabs = [await begin('a'), await begin('b')];
      try {
        for (const c of commands) {
          switch (c.kind) {
            case 'note':
              // A purged item takes no notes; item 3 only once it exists.
              if (hub.rows.has(id(c.item))) hub.upsertNote(10 * c.item + c.k, c.item, c.body);
              break;
            case 'drop':
              hub.removeNote(10 * c.item + c.k);
              break;
            case 'purge':
              hub.purge(c.item);
              purged = new Set([...purged, c.item]);
              break;
            case 'regroup':
              hub.regroup(c.item);
              break;
            case 'create':
              if (!created && !purged.has(3)) hub.upsert(3);
              created = true;
              break;
            case 'open': {
              const t = tabs[c.tab];
              t?.handles.push({ parent: id(c.item), handle: t.store.content.open(id(c.item)) });
              break;
            }
            case 'close':
              tabs[c.tab]?.handles.shift()?.handle.release();
              break;
            case 'prefetch':
              tabs[c.tab]?.store.content.prefetch(c.items.map(id));
              break;
            case 'budget':
              // One parent per multi-parent answer, or no budget.
              hub.contentBudget = hub.contentBudget === undefined ? 1 : undefined;
              break;
            case 'hold':
              hub.holdContent = true;
              break;
            case 'release':
              hub.holdContent = false;
              hub.releaseContent();
              break;
            case 'fail':
              hub.failContent += 1;
              break;
            case 'drop-socket':
              for (const connection of tabs[c.tab]?.connections ?? []) {
                if (connection.isOpen) connection.close(1006);
              }
              break;
            case 'tick':
              if (tabs[c.tab]?.life.dead === false) tabs[c.tab]?.timers.runNext();
              break;
            case 'kill': {
              const life = tabs[c.tab]?.life;
              if (life === undefined || life.dead) break;
              if (c.after > 0) life.dieAt = life.calls + c.after;
              else {
                life.die();
                await revive();
              }
              break;
            }
            case 'resync':
              void tabs[c.tab]?.store.resync().catch(() => undefined);
              break;
            case 'yield':
              // Macrotask turns: storage reads and the fake hub answer in them.
              await idle(c.turns);
              break;
            case 'wait':
              hub.holdContent = false;
              hub.releaseContent();
              await revive();
              await settle(hub, tabs);
              break;
          }
        }

        // Quiesce: answer held requests, stop failing them, reconnect, catch up.
        hub.holdContent = false;
        hub.failContent = 0;
        hub.releaseContent();
        // A tab set to die and not dead yet dies now, before quiet: its writes so far stay.
        for (const t of tabs) if (t.life.dieAt !== undefined) t.life.die();
        await revive();
        await settle(hub, tabs);
        // Quiet, the replica keeps at most the limit, beyond the items open in a tab (§5.4).
        const open = new Set<string>();
        for (const t of tabs) {
          for (const { parent } of t.handles) open.add(parent);
        }
        const stored = tabs[0]?.life.storages.at(-1);
        await eventually(
          async () => ((await stored?.readHydrated()) ?? []).length <= CACHE_LIMIT + open.size,
        );
        for (const t of tabs) await expectFetched(hub, t);
        // Closing waits for every queued storage write.
        for (const t of tabs) await t.store.close();

        // The shared replica stores, for every hydrated item, exactly the server's notes.
        const storage = await IndexedDbStorage.open(replica, NAMES, REFS);
        try {
          const meta = await storage.readMeta();
          for (const parent of await storage.readHydrated()) {
            const n = [...ITEMS, PROBE].find((k) => id(k) === parent);
            expect(n).toBeDefined();
            if (n === undefined) continue;
            const read = await storage.readContent(meta?.generation ?? '', parent);
            const stored = Object.fromEntries(read.records.map((r) => [r.row.id, r.row['body']]));
            expect(stored).toEqual(serverNotes(hub, n));
          }
        } finally {
          await storage.close();
        }

        // A tab started from the shared replica alone shows the same.
        const later = await begin('c');
        await settle(hub, [later]);
        await expectFetched(hub, later);
      } finally {
        // A dead tab's store is never closed, as in a crash; its storage calls never settle.
        for (const t of all) if (!t.life.dead) await t.store.close();
      }
    }),
    {
      seed: propertySeed(PROPERTY_SEED),
      numRuns: propertyRuns(150),
      examples: [
        // PLAN-011 S7: a prefetch cut by the budget (D16) while the answer is held and notes
        // change, evictions past the limit while the other tab keeps an item open, then reopens.
        [
          [
            { kind: 'open', tab: 1, item: 1 },
            { kind: 'create' },
            { kind: 'budget' },
            { kind: 'hold' },
            { kind: 'prefetch', tab: 0, items: [2, 3, 1] },
            { kind: 'yield', turns: 5 },
            { kind: 'note', item: 3, k: 1, body: 'B' },
            { kind: 'note', item: 2, k: 2, body: 'A' },
            { kind: 'release' },
            { kind: 'yield', turns: 5 },
            { kind: 'open', tab: 0, item: 2 },
            { kind: 'close', tab: 0 },
            { kind: 'drop', item: 2, k: 1 },
            { kind: 'wait' },
            { kind: 'open', tab: 0, item: 2 },
          ],
        ],
        // E17: an answer held while its item's notes change and a group change passes.
        [
          [
            { kind: 'hold' },
            { kind: 'open', tab: 0, item: 1 },
            { kind: 'yield', turns: 5 },
            { kind: 'note', item: 1, k: 1, body: 'B' },
            { kind: 'note', item: 1, k: 2, body: 'A' },
            { kind: 'regroup', item: 1 },
            { kind: 'release' },
          ],
        ],
        // Review B1: the tab dies as it starts the storage call after the answer's write; the tab
        // that takes its place pages item 1 in from the replica, which must hold the replayed note.
        [
          [
            { kind: 'hold' },
            { kind: 'open', tab: 0, item: 1 },
            { kind: 'yield', turns: 5 },
            { kind: 'note', item: 1, k: 1, body: 'B' },
            { kind: 'note', item: 1, k: 2, body: 'A' },
            { kind: 'yield', turns: 5 },
            { kind: 'kill', tab: 0, after: 2 },
            { kind: 'release' },
            { kind: 'yield', turns: 5 },
            { kind: 'wait' },
          ],
        ],
        // E23: a purge while the answer is held; E18: the other tab keeps item 2 live.
        [
          [
            { kind: 'open', tab: 0, item: 2 },
            { kind: 'wait' },
            { kind: 'note', item: 2, k: 2, body: 'A' },
            { kind: 'hold' },
            { kind: 'open', tab: 1, item: 1 },
            { kind: 'purge', item: 1 },
            { kind: 'release' },
          ],
        ],
      ],
    },
  );
  // The limit is small enough that runs evict: the property covers eviction, not just its absence.
  expect(evictions).toBeGreaterThan(0);
}, 240_000);

/** Run reconnects and retries to the end, then one probe every tab applies. */
async function settle(hub: FakeHub, tabs: readonly TabHandle[]): Promise<void> {
  const ready = ({ store }: TabHandle) => store.status === 'ready' && store.connection === 'online';
  for (let round = 0; round < 500 && !tabs.every(ready); round += 1) {
    for (const t of tabs) {
      if (t.store.connection === 'offline' || t.store.status === 'failed') t.timers.runNext();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  hub.upsert(PROBE, { title: `Probe ${String(hub.head)}` });
  for (const t of tabs) {
    await eventually(() => {
      const live = t.connections.filter((c) => c.isOpen).at(-1);
      return ready(t) && live !== undefined && t.store.position?.lastSyncId === live.sent;
    });
  }
}

/** Every item, opened now in the tab, shows the server's notes. */
async function expectFetched(hub: FakeHub, { store }: TabHandle): Promise<void> {
  const handles = ITEMS.map((n) => store.content.open(id(n)));
  try {
    for (const [index, handle] of handles.entries()) {
      const n = ITEMS[index] ?? 0;
      expect(await handle.ready).toBe('ready');
      expect(shownNotes(store, n)).toEqual(serverNotes(hub, n));
    }
  } finally {
    for (const handle of handles) handle.release();
  }
}
