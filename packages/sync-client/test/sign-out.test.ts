// SPEC-012 §3.12, AC-29 (client half): an explicit sign-out deletes the replica database; a later
// sign-in finds none and bootstraps fresh. A session expiry never calls `destroy`.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { replicaName } from '../src/storage/open.js';
import type { SyncStorage } from '../src/storage/types.js';
import { SyncStore } from '../src/store.js';
import { DebugItem, TEST_MODELS, debugRow } from './support/models.js';
import { quietConnection } from './support/hub.js';
import { FIXTURE_OPS, debugRename } from './support/ops.js';
import { bootstrapFrames, fakeFetch, ndjsonResponse } from './support/server.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

const serve = () => ndjsonResponse(bootstrapFrames([{ model: 'DebugItem', row: debugRow(1) }]));

function storeFor(
  workspaceId: string,
  fetch: ReturnType<typeof fakeFetch>,
  userId = 'user-1',
  options: Partial<ConstructorParameters<typeof SyncStore>[0]> = {},
) {
  return new SyncStore({
    models: TEST_MODELS,
    operations: FIXTURE_OPS,
    workspaceId,
    userId,
    fetch,
    connectStorage: connectViaRpc,
    connection: quietConnection(),
    ...options,
  });
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).flatMap((db) => (db.name === undefined ? [] : [db.name]));
}

describe('sign-out deletes the replica', () => {
  it('deletes the whole database, queue included, and a later sign-in bootstraps fresh (AC-29)', async () => {
    const workspace = uniqueName('ws');
    const name = replicaName(workspace, 'user-1');
    const first = storeFor(workspace, fakeFetch(serve));
    expect(await first.start()).toBe('cold');
    const item = first.pool.all(DebugItem)[0];
    expect(item).toBeDefined();
    void first.dispatch(debugRename, { id: item?.id ?? '', title: 'Unsent' });
    expect(first.pending).toHaveLength(1);
    expect(await databaseNames()).toContain(name);

    await first.destroy();
    expect(await databaseNames()).not.toContain(name);
    expect(first.status).toBe('idle');

    const fetch = fakeFetch(serve);
    const second = storeFor(workspace, fetch);
    expect(await second.start()).toBe('cold');
    expect(fetch.urls.length).toBeGreaterThan(0);
    expect(second.pending).toEqual([]);
    expect(second.pool.all(DebugItem)[0]?.title).not.toBe('Unsent');
    await second.close();
  });

  it('a plain close keeps the replica, as a session expiry does (SPEC-012 §3.12 item 4)', async () => {
    const workspace = uniqueName('ws');
    const first = storeFor(workspace, fakeFetch(serve));
    await first.start();
    await first.close();
    expect(await databaseNames()).toContain(replicaName(workspace, 'user-1'));

    const offline = fakeFetch();
    const second = storeFor(workspace, offline);
    expect(await second.start()).toBe('warm');
    expect(offline.urls).toEqual([]);
    await second.close();
  });

  it('only deletes its own user’s database', async () => {
    const workspace = uniqueName('ws');
    const other = storeFor(workspace, fakeFetch(serve), 'user-2');
    await other.start();
    await other.close();
    const mine = storeFor(workspace, fakeFetch(serve));
    await mine.start();
    await mine.destroy();
    expect(await databaseNames()).toContain(replicaName(workspace, 'user-2'));
  });

  it('drops the in-memory rows, and still deletes by name when it fell back to memory', async () => {
    const deleted: string[] = [];
    const store = storeFor('ws-x', fakeFetch(serve), 'user-1', {
      connectStorage: () => Promise.reject(new Error('no indexeddb')),
      deleteStorage: (n) => {
        deleted.push(n);
        return Promise.resolve();
      },
    });
    await store.start();
    expect(store.persistent).toBe(false);
    expect(store.pool.all(DebugItem)).toHaveLength(1);
    await store.destroy();
    expect(store.pool.all(DebugItem)).toEqual([]);
    expect(deleted).toEqual([replicaName('ws-x', 'user-1')]);
  });

  it('closes another open tab’s connection, so the delete completes (SPEC-012 §3.12 item 3)', async () => {
    const workspace = uniqueName('ws');
    const name = replicaName(workspace, 'user-1');
    let otherStorage: SyncStorage | undefined;
    const a = storeFor(workspace, fakeFetch(serve));
    const b = storeFor(workspace, fakeFetch(serve), 'user-1', {
      connectStorage: async (dbName, models) => {
        otherStorage = await connectViaRpc(dbName, models);
        return otherStorage;
      },
    });
    await a.start();
    await b.start();
    await a.destroy();
    expect(await databaseNames()).not.toContain(name);
    // The `versionchange` of the delete closed B's connection, offline too, before any 4001.
    await expect(otherStorage?.readMeta()).rejects.toThrow('You logged out in another tab.');
    await b.close();
  });
});

describe('counting unsent changes before sign-out', () => {
  it('includes the changes other tabs queued, because the delete discards every queue', async () => {
    const workspace = uniqueName('ws');
    const a = storeFor(workspace, fakeFetch(serve));
    const b = storeFor(workspace, fakeFetch(serve));
    await a.start();
    await b.start();
    expect(await a.countPending()).toBe(0);
    const item = b.pool.all(DebugItem)[0];
    void b.dispatch(debugRename, { id: item?.id ?? '', title: 'B offline' });
    expect(b.pending).toHaveLength(1);
    expect(a.pending).toHaveLength(0);
    await vi.waitFor(async () => {
      expect(await a.countPending()).toBe(1);
    });
    await a.close();
    await b.close();
  });
});
