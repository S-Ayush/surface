// SPEC-012 §3.12, AC-29 (client half): an explicit sign-out deletes the replica database; a later
// sign-in finds none and bootstraps fresh. A session expiry never calls `destroy`.
import { afterAll, describe, expect, it } from 'vitest';
import { replicaName } from '../src/storage/open.js';
import { SyncStore } from '../src/store.js';
import { DebugItem, TEST_MODELS, debugRow } from './support/models.js';
import { quietConnection } from './support/hub.js';
import { FIXTURE_OPS, debugRename } from './support/ops.js';
import { bootstrapFrames, fakeFetch, ndjsonResponse } from './support/server.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

const serve = () => ndjsonResponse(bootstrapFrames([{ model: 'DebugItem', row: debugRow(1) }]));

function storeFor(workspaceId: string, fetch: ReturnType<typeof fakeFetch>, userId = 'user-1') {
  return new SyncStore({
    models: TEST_MODELS,
    operations: FIXTURE_OPS,
    workspaceId,
    userId,
    fetch,
    connectStorage: connectViaRpc,
    connection: quietConnection(),
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

  it('a plain close keeps the replica, as a session expiry does (E30, SPEC-012 §3.12 item 4)', async () => {
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

  it('uses the injected delete for a store that fell back to memory, which just drops', async () => {
    const deleted: string[] = [];
    const store = new SyncStore({
      models: TEST_MODELS,
      workspaceId: 'ws-x',
      userId: 'user-1',
      fetch: fakeFetch(serve),
      connection: quietConnection(),
      connectStorage: () => Promise.reject(new Error('no indexeddb')),
      deleteStorage: (n) => {
        deleted.push(n);
        return Promise.resolve();
      },
    });
    await store.start();
    expect(store.persistent).toBe(false);
    await store.destroy();
    expect(deleted).toEqual([replicaName('ws-x', 'user-1')]);
  });
});
