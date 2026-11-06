import { when } from 'mobx';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { StorageConnector } from '../../src/storage/open.js';
import type { SyncStoreOptions } from '../../src/store.js';
import { SyncStore } from '../../src/store.js';
import type { FakeHub } from './hub.js';
import { DebugItem, TEST_MODELS } from './models.js';
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
    userId: 'user-1',
    fetch: hub.fetch,
    // Absolute: Node has no page origin to resolve the socket URL against.
    baseUrl: 'http://surface.test',
    connectStorage: memoryStorage,
    clientId: CLIENT_ID,
    ...options,
    connection: { socket: hub.socket, timers, random: () => 0, ...options.connection },
  });
  return { store, timers };
}

/** Wait for an observable condition on the store; fails after `ms` instead of hanging. */
export function until(predicate: () => boolean, ms = 5000): Promise<void> {
  return when(predicate, { timeout: ms });
}

export interface ItemView {
  title: unknown;
  counter: unknown;
  archived: boolean;
}

/** The client's visible DebugItems, by id. */
export function clientItems(store: SyncStore): Record<string, ItemView> {
  const entries = store.pool
    .all(DebugItem)
    .map((item): [string, ItemView] => [
      item.id,
      { title: item.title, counter: item.counter, archived: item.$archived },
    ]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** The server's DebugItems, by id, in the same shape. */
export function serverItems(hub: FakeHub): Record<string, ItemView> {
  return Object.fromEntries(
    [...hub.rows.values()]
      .map(
        ({ row, archived }) =>
          [row.id, { title: row['title'], counter: row['counter'], archived }] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
