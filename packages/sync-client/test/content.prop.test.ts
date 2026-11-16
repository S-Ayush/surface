/**
 * The content property (sync property suite; SPEC-011 AC-8, E17, E18, E23, E24, E25; PLAN-011
 * S5b), on the fake hub's debug items and their notes: two tabs share one IndexedDB replica.
 * Note writes and deletes, item purges (whose note deletes are not logged), group changes (`D`+`U`),
 * new items, opens and releases in either tab, held and failed content answers, socket drops and
 * resyncs interleave. Once quiet, every item each tab opens shows exactly the server's notes (a
 * fresh fetch), the shared replica stores exactly those for every hydrated item, and a tab started
 * afterwards from the replica alone shows the same.
 */
import 'fake-indexeddb/auto';
import { computeSchemaHash } from '@surface/sync-protocol';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { ContentHandle } from '../src/content.js';
import type { SocketFactory } from '../src/socket.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import type { SyncStore } from '../src/store.js';
import { PROPERTY_SEED } from './support/fc.js';
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

type Tab = 0 | 1;
interface TabHandle {
  readonly store: SyncStore;
  readonly timers: ManualTimers;
  readonly connections: HubConnection[];
  readonly handles: ContentHandle[];
}

type Command =
  | { kind: 'note'; item: number; k: number; body: string }
  | { kind: 'drop'; item: number; k: number }
  | { kind: 'purge' | 'regroup'; item: number }
  | { kind: 'create' }
  | { kind: 'open'; tab: Tab; item: number }
  | { kind: 'close'; tab: Tab }
  | { kind: 'hold' | 'release' | 'fail' }
  | { kind: 'drop-socket' | 'tick' | 'resync'; tab: Tab }
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
      const connect: StorageConnector = (name, models, content) =>
        IndexedDbStorage.open(name, models, content);
      const all: SyncStore[] = [];
      const begin = async (name: string): Promise<TabHandle> => {
        const connections: HubConnection[] = [];
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
          connection: { socket },
        });
        all.push(store);
        await store.start();
        return { store, timers, connections, handles: [] };
      };
      try {
        const tabs = [await begin('a'), await begin('b')];

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
              t?.handles.push(t.store.content.open(id(c.item)));
              break;
            }
            case 'close':
              tabs[c.tab]?.handles.shift()?.release();
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
              tabs[c.tab]?.timers.runNext();
              break;
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
              await settle(hub, tabs);
              break;
          }
        }

        // Quiesce: answer held requests, stop failing them, reconnect, catch up.
        hub.holdContent = false;
        hub.failContent = 0;
        hub.releaseContent();
        await settle(hub, tabs);
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
        for (const store of all) await store.close();
      }
    }),
    {
      seed: PROPERTY_SEED,
      numRuns: 150,
      examples: [
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
