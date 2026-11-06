import { computeSchemaHash } from '@surface/sync-protocol';
import { reaction, when } from 'mobx';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { replicaName } from '../src/storage/open.js';
import type { SyncStatus } from '../src/store.js';
import { ObjectPool } from '../src/pool.js';
import type { SyncStorage } from '../src/storage/types.js';
import { SyncStore } from '../src/store.js';
import { Board, Card, DebugItem, TEST_MODELS, debugRow, id } from './support/models.js';
import { bootstrapFrames, fakeFetch, gatedResponse, ndjsonResponse } from './support/server.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

const items = (...ns: number[]) => ns.map((n) => ({ model: 'DebugItem', row: debugRow(n) }));
const serve =
  (rows: ReturnType<typeof items>, lastSyncId = 100) =>
  () =>
    ndjsonResponse(bootstrapFrames(rows, { lastSyncId }));

afterAll(closePorts);

function storeFor(
  workspaceId: string,
  fetch: ReturnType<typeof fakeFetch>,
  options: Partial<ConstructorParameters<typeof SyncStore>[0]> = {},
) {
  return new SyncStore({
    models: TEST_MODELS,
    workspaceId,
    userId: 'user-1',
    fetch,
    connectStorage: connectViaRpc,
    ...options,
  });
}

describe('sync store start-up', () => {
  it('bootstraps on first start, then warm-starts from the replica without fetching (SPEC-002 §3.1–3.2)', async () => {
    const workspace = uniqueName('ws');
    const first = storeFor(workspace, fakeFetch(serve(items(1, 2, 3), 42)));
    expect(await first.start()).toBe('cold');
    expect(first.persistent).toBe(true);
    await first.close();

    const offline = fakeFetch();
    const second = storeFor(workspace, offline);
    expect(await second.start()).toBe('warm');
    expect(offline.urls).toEqual([]);
    expect(
      second.pool
        .all(DebugItem)
        .map((item) => item.title)
        .sort(),
    ).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect(second.position).toMatchObject({ lastSyncId: 42, groups: ['workspace'] });
    expect(second.position?.generation).toEqual(expect.any(String));
    expect(second.status).toBe('ready');
    await second.close();
  });

  it('keeps archived rows archived through bootstrap and warm start', async () => {
    const workspace = uniqueName('ws');
    const rows = [...items(1), { model: 'DebugItem', row: debugRow(2), archived: true }];
    const first = storeFor(
      workspace,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(rows))),
    );
    await first.start();
    expect(first.pool.get(DebugItem, id(2))?.$archived).toBe(true);
    await first.close();

    const second = storeFor(workspace, fakeFetch());
    expect(await second.start()).toBe('warm');
    expect(second.pool.get(DebugItem, id(1))?.$archived).toBe(false);
    expect(second.pool.get(DebugItem, id(2))?.$archived).toBe(true);
    await second.close();
  });

  it('names the replica after the workspace and the user', async () => {
    const opened: string[] = [];
    const store = storeFor('ws-1', fakeFetch(serve([])), {
      connectStorage: (name, models) => {
        opened.push(name);
        return IndexedDbStorage.open(name, models);
      },
    });
    await store.start();
    expect(opened).toEqual([replicaName('ws-1', 'user-1')]);
    expect(replicaName('ws-1', 'user-1')).toBe('surface-ws-1-user-1');
    await store.close();
  });

  it('bootstraps again when the stored replica belongs to another schema (E7)', async () => {
    const workspace = uniqueName('ws');
    const oldHash = computeSchemaHash([DebugItem]);
    const oldServer = () => ndjsonResponse(bootstrapFrames(items(1, 2), { schemaHash: oldHash }));
    const old = storeFor(workspace, fakeFetch(oldServer), { models: [DebugItem] });
    await old.start();
    await old.close();

    const fetch = fakeFetch(serve(items(3)));
    const updated = storeFor(workspace, fetch);
    expect(await updated.start()).toBe('cold');
    expect(updated.pool.all(DebugItem).map((item) => item.id)).toEqual([id(3)]);
    await updated.close();
  });

  it('bootstraps again when the last bootstrap never finished', async () => {
    const workspace = uniqueName('ws');
    const interrupted = storeFor(
      workspace,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(items(1, 2)).slice(0, -1))),
    );
    await expect(interrupted.start()).rejects.toThrow(/stopped arriving/);
    expect(interrupted.status).toBe('failed');
    await interrupted.close();

    const retry = storeFor(workspace, fakeFetch(serve(items(1, 2))));
    expect(await retry.start()).toBe('cold');
    await retry.close();
  });

  it('falls back to memory when IndexedDB cannot be opened, and says so (E6)', async () => {
    const store = storeFor(uniqueName('ws'), fakeFetch(serve(items(1))), {
      connectStorage: () => Promise.reject(new Error('IndexedDB is not available')),
    });
    expect(await store.start()).toBe('cold');
    expect(store.pool.count(DebugItem)).toBe(1);
    expect(store.persistent).toBe(false);
    expect(store.storageWarning).toBe('IndexedDB is not available');
  });

  it('moves through hydrating, bootstrapping and ready, with progress while bootstrapping', async () => {
    const store = storeFor(uniqueName('ws'), fakeFetch(serve(items(1, 2, 3))), { chunkSize: 2 });
    const statuses: SyncStatus[] = [];
    const totals: (string | undefined)[] = [];
    const stopStatus = reaction(
      () => store.status,
      (status) => statuses.push(status),
    );
    const stopProgress = reaction(
      () => store.progress,
      (progress) => totals.push(progress && `${progress.loaded}/${progress.total}`),
    );
    await store.start();
    stopStatus();
    stopProgress();
    expect(statuses).toEqual(['hydrating', 'bootstrapping', 'ready']);
    expect(totals).toEqual(['0/3', '2/3', '3/3', undefined]);
    await store.close();
  });

  it('re-bootstraps on resync, keeping optimistic overlays (E8)', async () => {
    const store = storeFor(
      uniqueName('ws'),
      fakeFetch(serve(items(1, 2)), serve(items(2, 5), 500)),
    );
    await store.start();
    // Stands in for the overlay engine (PLAN-002 S8), which owns the writable pool.
    const pool: unknown = store.pool;
    if (!(pool instanceof ObjectPool)) throw new Error('expected the object pool');
    pool.setOverlay('DebugItem', id(7), { row: debugRow(7), archived: false });
    await store.resync();
    expect(
      store.pool
        .all(DebugItem)
        .map((item) => item.id)
        .sort(),
    ).toEqual([id(2), id(5), id(7)]);
    expect(store.position?.lastSyncId).toBe(500);
    await store.close();
  });

  it('hashes its model list into the schema hash it sends', () => {
    const a = storeFor('ws', fakeFetch(), { models: [DebugItem, Board, Card] });
    const b = storeFor('ws', fakeFetch(), { models: [Card, Board, DebugItem] });
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sync store lifecycle', () => {
  it('runs start and resync one after the other, on one storage connection', async () => {
    let connections = 0;
    const store = storeFor(uniqueName('ws'), fakeFetch(serve(items(1)), serve(items(2), 200)), {
      connectStorage: (name, models) => {
        connections += 1;
        return connectViaRpc(name, models);
      },
    });
    await Promise.all([store.start(), store.resync()]);
    expect(connections).toBe(1);
    expect(store.position?.lastSyncId).toBe(200);
    expect(store.pool.all(DebugItem).map((item) => item.id)).toEqual([id(2)]);
    await store.close();
  });

  it('opens storage again when started after close', async () => {
    const workspace = uniqueName('ws');
    const store = storeFor(workspace, fakeFetch(serve(items(1))));
    await store.start();
    await store.close();
    expect(await store.start()).toBe('warm');
    expect(store.persistent).toBe(true);
    await store.close();
  });

  it('stops a bootstrap in progress when closed, cancelling the download', async () => {
    const frames = bootstrapFrames(items(1, 2));
    const gated = gatedResponse(frames.slice(0, 1), frames.slice(1));
    const store = storeFor(
      uniqueName('ws'),
      fakeFetch(() => gated.response),
    );
    const starting = store.start();
    await when(() => store.progress !== undefined);
    await store.close();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(gated.state.cancelled).toBe(true);
    expect(store.status).toBe('idle');
    expect(store.progress).toBeUndefined();
    gated.release();
  });
});

describe('closing the store', () => {
  /**
   * IndexedDB storage that calls `onReadMeta` with the call number once each
   * `readMeta` has its answer, before the caller sees it: the moment a reply
   * is in flight from the worker.
   */
  const watchedStorage =
    (onReadMeta: (call: number) => void) =>
    async (name: string, models: readonly string[]): Promise<SyncStorage> => {
      const storage = await IndexedDbStorage.open(name, models);
      const readMeta = storage.readMeta.bind(storage);
      let calls = 0;
      storage.readMeta = async () => {
        const meta = await readMeta();
        calls += 1;
        onReadMeta(calls);
        return meta;
      };
      return storage;
    };

  it('stops a warm start closed during its last read: it never reports ready', async () => {
    const workspace = uniqueName('ws');
    const seed = storeFor(workspace, fakeFetch(serve(items(1, 2))));
    await seed.start();
    await seed.close();

    let close: () => Promise<void> = () => Promise.resolve();
    let closing: Promise<void> | undefined;
    const store = storeFor(workspace, fakeFetch(), {
      // Hydrate's second readMeta is its last storage call before ready.
      connectStorage: watchedStorage((call) => {
        if (call === 2) closing = close();
      }),
    });
    close = () => store.close();
    await expect(store.start()).rejects.toMatchObject({ name: 'AbortError' });
    await closing;
    expect(store.status).toBe('idle');
    expect(store.position).toBeUndefined();
  });

  it('returns a started store to idle', async () => {
    const store = storeFor(uniqueName('ws'), fakeFetch(serve(items(1))));
    await store.start();
    await store.close();
    expect(store.status).toBe('idle');
    expect(store.position).toBeUndefined();
    expect(store.progress).toBeUndefined();
    expect(store.persistent).toBe(false);
  });
});

describe('several tabs on one replica (E5)', () => {
  /** `navigator.locks`, calling `onRequest` whenever a lock is asked for. */
  const watchedLocks = (onRequest: (mode: string | undefined) => void) => ({
    request: <T>(name: string, options: LockOptions, callback: () => Promise<T>): Promise<T> => {
      onRequest(options.mode);
      return navigator.locks.request(name, options, callback);
    },
  });

  it('waits for a tab that is bootstrapping, then warm-starts from its replica', async () => {
    const workspace = uniqueName('ws');
    const frames = bootstrapFrames(items(1, 2), { lastSyncId: 7 });
    const gated = gatedResponse(frames.slice(0, 1), frames.slice(1));
    const a = storeFor(
      workspace,
      fakeFetch(() => gated.response),
    );
    const startingA = a.start();
    await when(() => a.progress !== undefined); // A has begun writing its replica.

    // B must not fetch: it waits for A, then reads what A stored.
    const b = storeFor(workspace, fakeFetch(), {
      locks: watchedLocks(() => gated.release()),
    });
    const startingB = b.start();
    void startingB.catch(() => gated.release());

    expect(await startingA).toBe('cold');
    expect(await startingB).toBe('warm');
    expect(b.pool.count(DebugItem)).toBe(2);
    expect(b.position?.generation).toBe(a.position?.generation);
    expect(a.persistent).toBe(true);
    await a.close();
    await b.close();
  });

  it('bootstraps once when two tabs start on an empty replica', async () => {
    const workspace = uniqueName('ws');
    const a = storeFor(workspace, fakeFetch(serve(items(1))));
    const b = storeFor(workspace, fakeFetch(serve(items(1))));
    const results = await Promise.all([a.start(), b.start()]);
    expect(results.sort()).toEqual(['cold', 'warm']);
    expect(a.position?.generation).toBe(b.position?.generation);
    await a.close();
    await b.close();
  });
});
