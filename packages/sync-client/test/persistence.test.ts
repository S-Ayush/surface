import { describe, expect, it } from 'vitest';
import { Persistence } from '../src/persistence.js';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { TEST_MODELS } from './support/models.js';
import { TEST_SCHEMA_HASH } from './support/server.js';
import { uniqueName } from './support/storage.js';

const names = TEST_MODELS.map((m) => m.name);
const START = { schemaHash: TEST_SCHEMA_HASH, lastSyncId: 1, groups: ['workspace' as const] };

describe('persistence', () => {
  it('treats a write fenced by another tab as that generation ending, not as storage failing (E5)', async () => {
    const storage = await IndexedDbStorage.open(uniqueName(), names);
    const persistence = new Persistence(storage, undefined);
    const ours = await persistence.write((s) => s.beginBootstrap(START));
    if (ours === undefined) throw new Error('beginBootstrap failed');
    const theirs = await storage.beginBootstrap(START); // another tab
    expect(await persistence.writeReplica(ours, (s) => s.finishBootstrap(ours))).toBeUndefined();
    expect(persistence.isCurrent(ours)).toBe(false);
    // The other tab persists the same data, so nothing is lost: no warning.
    expect(persistence.persistent).toBe(true);
    expect(persistence.warning).toBeUndefined();
    expect(await persistence.write((s) => s.readMeta())).toMatchObject({ generation: theirs });
    await storage.close();
  });

  it('stops persisting and warns on any other failure (E6)', async () => {
    const storage = await IndexedDbStorage.open(uniqueName(), names);
    const persistence = new Persistence(storage, undefined);
    const quota = () =>
      Promise.reject(new Error('Storage is full. Free up disk space and reload.'));
    expect(await persistence.write(quota)).toBeUndefined();
    expect(persistence.persistent).toBe(false);
    expect(persistence.warning).toMatch(/Storage is full/);
    expect(await persistence.write((s) => s.readMeta())).toBeUndefined();
    await storage.close();
  });

  it('writes to the memory fallback, but never calls it persistent', async () => {
    const persistence = new Persistence(new MemoryStorage(names), 'IndexedDB is not available');
    const generation = await persistence.write((s) => s.beginBootstrap(START));
    expect(generation).toEqual(expect.any(String));
    expect(persistence.persistent).toBe(false);
    expect(persistence.warning).toBe('IndexedDB is not available');
  });
});
