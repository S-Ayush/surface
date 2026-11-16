import { when } from 'mobx';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { StorageConnector } from '../../src/storage/open.js';
import type { SyncStoreOptions } from '../../src/store.js';
import { SyncStore } from '../../src/store.js';
import type { FakeHub } from './hub.js';
import {
  DebugItem,
  PARTIAL_TEST_LOADING,
  PARTIAL_TEST_MODELS,
  TEST_MODELS,
  USER_ID,
} from './models.js';
import { FIXTURE_OPS } from './ops.js';
import { uniqueName } from './storage.js';
import { ManualTimers } from './timers.js';

export const CLIENT_ID = '0190f4c4-0000-7000-8000-00000000c11e';

export const memoryStorage: StorageConnector = (_name, models) =>
  Promise.resolve(new MemoryStorage(models));

/** A store wired to `hub`, with manual timers and no jitter. */
export function liveStore(
  hub: FakeHub,
  options: Partial<SyncStoreOptions> & { timers?: ManualTimers } = {},
) {
  const timers = options.timers ?? new ManualTimers();
  const store = new SyncStore({
    models: TEST_MODELS,
    workspaceId: uniqueName('ws'),
    userId: USER_ID,
    fetch: hub.fetch,
    // Absolute: Node has no page origin to resolve the socket URL against.
    baseUrl: 'http://surface.test',
    connectStorage: memoryStorage,
    clientId: CLIENT_ID,
    operations: FIXTURE_OPS,
    ...options,
    connection: { socket: hub.socket, timers, random: () => 0, ...options.connection },
  });
  return { store, timers };
}

/**
 * Wait for a plain (non-observable) condition, such as a fake hub's counters
 * or pending timers: re-check after each turn of the event loop, failing
 * after `ms` instead of hanging. No sleeps: it yields a macrotask (`setTimeout(0)`) per check.
 */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(`Condition not met within ${ms} ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Let `turns` macrotasks run: to show that something does *not* happen meanwhile. */
export async function idle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A memory-storage connector that keeps the storage it opened, to inspect the queue. */
export function keptMemoryStorage() {
  const kept: { storage?: MemoryStorage } = {};
  const connect: StorageConnector = (_name, models) => {
    kept.storage = new MemoryStorage(models);
    return Promise.resolve(kept.storage);
  };
  const pending = async () => (await kept.storage?.readQueue())?.pending ?? [];
  /** How many mutations are persisted. */
  const persisted = async () => (await pending()).length;
  /** Whether the mutation with this seq is persisted. */
  const has = async (seq: number) => (await pending()).some((record) => record.seq === seq);
  /** The ids of a model's stored live rows. */
  const stored = async (model: string) =>
    ((await kept.storage?.readRows(model, undefined, 10_000))?.rows ?? []).map((r) => r.row.id);
  /** The stored replica's `lastSyncId`. */
  const lastSyncId = async () => (await kept.storage?.readMeta())?.lastSyncId ?? 0;
  /** The persisted queue: every client (with its `nextSeq`) and pending record. */
  const queue = async () => kept.storage?.readQueue();
  return { connect, persisted, has, stored, lastSyncId, queue };
}

/** Wait for an observable condition on the store; fails after `ms` instead of hanging. */
export function until(predicate: () => boolean, ms = 5000): Promise<void> {
  return when(predicate, { timeout: ms });
}

export interface ItemView {
  title: unknown;
  counter: unknown;
  archivedAt: unknown;
  archived: boolean;
}

/** The client's visible DebugItems, by id. */
export function clientItems(store: SyncStore): Record<string, ItemView> {
  const entries = store.pool.all(DebugItem).map((item): [string, ItemView] => [
    item.id,
    {
      title: item.title,
      counter: item.counter,
      archivedAt: item.archivedAt,
      archived: item.$archived,
    },
  ]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** A store on the stand-in team world (PLAN-011 S4c): `hub.withTeams()` first. */
export function teamStore(
  hub: FakeHub,
  options: Partial<SyncStoreOptions> & { timers?: ManualTimers } = {},
) {
  return liveStore(hub, {
    models: PARTIAL_TEST_MODELS,
    partial: PARTIAL_TEST_LOADING,
    ...options,
  });
}

/** What a store shows of the team world: tasks (title and groups), parts and notes, by id. */
export function teamView(store: SyncStore) {
  const byId = <T>(entries: [string, T][]) =>
    Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  return {
    tasks: byId(
      store.pool
        .all('Task')
        .map((t): [string, unknown] => [t.id, { title: t['title'], groups: t['groups'] }]),
    ),
    parts: byId(store.pool.all('TaskPart').map((p): [string, unknown] => [p.id, p['issueId']])),
    notes: byId(store.pool.all('TaskNote').map((n): [string, unknown] => [n.id, n['issueId']])),
  };
}

/** The server's DebugItems, by id, in the same shape. */
export function serverItems(hub: FakeHub): Record<string, ItemView> {
  return Object.fromEntries(
    [...hub.rows.values()]
      .map(
        ({ row, archived }) =>
          [
            row.id,
            {
              title: row['title'],
              counter: row['counter'],
              archivedAt: row['archivedAt'],
              archived,
            },
          ] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
