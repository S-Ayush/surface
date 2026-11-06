import { describe, expect, it } from 'vitest';
import { hydrate } from '../src/hydrate.js';
import { Persistence } from '../src/persistence.js';
import { ObjectPool } from '../src/pool.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { MemoryStorage } from '../src/storage/memory.js';
import type { SyncStorage } from '../src/storage/types.js';
import { DebugItem, TEST_MODELS, debugRow, id } from './support/models.js';
import { TEST_SCHEMA_HASH } from './support/server.js';
import { uniqueName } from './support/storage.js';

const names = TEST_MODELS.map((m) => m.name);
const START = { schemaHash: TEST_SCHEMA_HASH, lastSyncId: 50, groups: ['workspace' as const] };

async function seed(storage: SyncStorage, ...ns: number[]): Promise<string> {
  const generation = await storage.beginBootstrap(START);
  await storage.writeBootstrapRows(
    generation,
    ns.map((n) => ({ model: 'DebugItem', row: debugRow(n), archived: false })),
  );
  await storage.finishBootstrap(generation);
  return generation;
}

describe('warm start', () => {
  it('hydrates from the in-memory fallback too, so the tab still has its pending queue (E6)', async () => {
    const storage = new MemoryStorage(names);
    await seed(storage, 1, 2);
    const pool = new ObjectPool(TEST_MODELS);
    const result = await hydrate(pool, new Persistence(storage, undefined), TEST_SCHEMA_HASH);
    expect(result?.rows).toBe(2);
    expect(pool.count(DebugItem)).toBe(2);
  });

  it('drops base rows from before the warm start that the replica does not have', async () => {
    const storage = new MemoryStorage(names);
    await seed(storage, 1);
    const pool = new ObjectPool(TEST_MODELS);
    pool.loadBase('DebugItem', [{ row: debugRow(9), archived: false }]);
    await hydrate(pool, new Persistence(storage, undefined), TEST_SCHEMA_HASH);
    expect(pool.all(DebugItem).map((item) => item.id)).toEqual([id(1)]);
  });

  it('gives up when another tab re-bootstraps the replica while it is being read', async () => {
    const storage = await IndexedDbStorage.open(uniqueName(), names);
    await seed(storage, 1, 2, 3);
    const readRows = storage.readRows.bind(storage);
    let pages = 0;
    storage.readRows = async (model, after, limit) => {
      pages += 1;
      // Another tab bootstraps from scratch, all the way to ready, between our
      // first and second page: only the generation tells the replicas apart.
      if (pages === 2) {
        const theirs = await storage.beginBootstrap({ ...START, lastSyncId: 90 });
        await storage.writeBootstrapRows(theirs, [
          { model: 'DebugItem', row: debugRow(7), archived: false },
        ]);
        await storage.finishBootstrap(theirs);
      }
      return readRows(model, after, limit);
    };
    const pool = new ObjectPool(TEST_MODELS);
    const result = await hydrate(pool, new Persistence(storage, undefined), TEST_SCHEMA_HASH, 1);
    expect(result).toBeUndefined();
    await storage.close();
  });
});
