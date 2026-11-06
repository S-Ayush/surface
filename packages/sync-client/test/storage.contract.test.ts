import { afterAll, describe, expect, it } from 'vitest';
import type { StoredChange, SyncStorage } from '../src/storage/types.js';
import { StorageFencedError } from '../src/storage/types.js';
import { debugRow, id } from './support/models.js';
import { BACKENDS, closePorts, uniqueName } from './support/storage.js';

const MODELS = ['DebugItem', 'Card'];
const HASH = 'a'.repeat(64);
const start = (lastSyncId = 10) => ({
  schemaHash: HASH,
  lastSyncId,
  groups: ['workspace' as const],
});
const rows = (...ns: number[]) =>
  ns.map((n) => ({ model: 'DebugItem', row: debugRow(n), archived: false }));

async function readAll(storage: SyncStorage, model = 'DebugItem', pageSize = 1000) {
  const all = [];
  let after: string | undefined;
  do {
    const page = await storage.readRows(model, after, pageSize);
    all.push(...page.rows);
    after = page.next;
  } while (after !== undefined);
  return all;
}

const upsert = (
  version: number,
  n: number,
  fields: Record<string, unknown> = {},
): StoredChange => ({
  kind: 'upsert',
  model: 'DebugItem',
  version,
  row: debugRow(n, fields),
});
const change = (
  kind: 'archive' | 'unarchive' | 'delete',
  version: number,
  n: number,
): StoredChange => ({
  kind,
  model: 'DebugItem',
  version,
  id: id(n),
});

afterAll(closePorts);

describe.each(BACKENDS)('$name storage', (backend) => {
  const open = (name: string) => backend.open(name, MODELS);

  it('stores a bootstrap and reads it back, marking it ready only at the end', async () => {
    const storage = await open(uniqueName());
    expect(await storage.readMeta()).toBeUndefined();
    const generation = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(generation, rows(1, 2, 3));
    expect(await storage.readMeta()).toMatchObject({ state: 'bootstrapping', lastSyncId: 10 });
    await storage.finishBootstrap(generation);
    expect(await storage.readMeta()).toMatchObject({
      state: 'ready',
      generation,
      schemaHash: HASH,
    });
    expect((await readAll(storage)).map((r) => r.row)).toEqual([
      debugRow(1),
      debugRow(2),
      debugRow(3),
    ]);
    await storage.close();
  });

  it('keeps the archived flag of bootstrap rows', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(generation, [
      { model: 'DebugItem', row: debugRow(1), archived: true },
    ]);
    expect(await readAll(storage)).toEqual([{ row: debugRow(1), archived: true }]);
    await storage.close();
  });

  it('pages through rows in id order', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(generation, rows(5, 1, 4, 2, 3));
    const first = await storage.readRows('DebugItem', undefined, 2);
    expect(first.rows.map((r) => r.row.id)).toEqual([id(1), id(2)]);
    expect(first.next).toBe(id(2));
    expect((await readAll(storage, 'DebugItem', 2)).length).toBe(5);
    await storage.close();
  });

  it('starts every bootstrap from an empty replica', async () => {
    const storage = await open(uniqueName());
    const first = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(first, rows(1, 2));
    const second = await storage.beginBootstrap(start(20));
    await storage.writeBootstrapRows(second, rows(3));
    expect((await readAll(storage)).map((r) => r.row.id)).toEqual([id(3)]);
    await storage.close();
  });

  it('applies deltas and advances lastSyncId in the same write', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start(10));
    await storage.writeBootstrapRows(generation, rows(1, 2));
    await storage.applyChanges(
      generation,
      [upsert(11, 1, { title: 'Renamed' }), change('archive', 12, 2), upsert(13, 3)],
      13,
    );
    const stored = await readAll(storage);
    expect(stored).toEqual([
      { row: debugRow(1, { title: 'Renamed' }), archived: false },
      { row: debugRow(2), archived: true },
      { row: debugRow(3), archived: false },
    ]);
    expect((await storage.readMeta())?.lastSyncId).toBe(13);
    await storage.close();
  });

  it('keeps a lagging tab from undoing newer changes (versions, tombstones, lastSyncId)', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start(10));
    await storage.writeBootstrapRows(generation, rows(1, 2));
    // The fast tab is at 20: row 1 renamed at 15, row 2 deleted at 18.
    await storage.applyChanges(
      generation,
      [upsert(15, 1, { title: 'New' }), change('delete', 18, 2)],
      20,
    );
    // The slow tab replays 11–14: an older rename of row 1 and an older update of row 2.
    await storage.applyChanges(
      generation,
      [upsert(11, 1, { title: 'Old' }), upsert(14, 2, { title: 'Zombie' })],
      14,
    );
    expect((await readAll(storage)).map((r) => r.row)).toEqual([debugRow(1, { title: 'New' })]);
    expect((await storage.readMeta())?.lastSyncId).toBe(20);
    await storage.close();
  });

  it('ignores archive and unarchive for rows it never stored', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start());
    await storage.applyChanges(
      generation,
      [change('archive', 11, 7), change('unarchive', 12, 7)],
      12,
    );
    expect(await readAll(storage)).toEqual([]);
    await storage.close();
  });

  it('fences a tab once another tab re-bootstraps the replica', async () => {
    const name = uniqueName();
    const tabA = await open(name);
    const tabB = await open(name);
    const generationA = await tabA.beginBootstrap(start());
    await tabA.writeBootstrapRows(generationA, rows(1));
    const generationB = await tabB.beginBootstrap(start(30));

    await expect(tabA.writeBootstrapRows(generationA, rows(2))).rejects.toBeInstanceOf(
      StorageFencedError,
    );
    await expect(tabA.applyChanges(generationA, [upsert(31, 1)], 31)).rejects.toBeInstanceOf(
      StorageFencedError,
    );
    await expect(tabA.finishBootstrap(generationA)).rejects.toBeInstanceOf(StorageFencedError);
    // The fenced writes changed nothing.
    await tabB.finishBootstrap(generationB);
    expect(await readAll(tabB)).toEqual([]);
    expect((await tabB.readMeta())?.lastSyncId).toBe(30);
    await tabA.close();
    await tabB.close();
  });

  it('clears rows and meta on resync', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(generation, rows(1));
    await storage.finishBootstrap(generation);
    await storage.clear();
    expect(await storage.readMeta()).toBeUndefined();
    expect(await readAll(storage)).toEqual([]);
    await expect(storage.applyChanges(generation, [upsert(11, 1)], 11)).rejects.toBeInstanceOf(
      StorageFencedError,
    );
    await storage.close();
  });

  it('rejects models it was not opened with', async () => {
    const storage = await open(uniqueName());
    await expect(storage.readRows('Nope', undefined, 10)).rejects.toThrow(/Unknown model Nope/);
    await storage.close();
  });

  it('writes nothing from a batch that names an unknown model', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start(10));
    await storage.writeBootstrapRows(generation, rows(1));
    const bad: StoredChange = { kind: 'delete', model: 'Nope', version: 12, id: id(9) };
    await expect(
      storage.applyChanges(generation, [upsert(11, 1, { title: 'Renamed' }), bad], 12),
    ).rejects.toThrow();
    expect(await readAll(storage)).toEqual([{ row: debugRow(1), archived: false }]);
    expect((await storage.readMeta())?.lastSyncId).toBe(10);
    await storage.close();
  });
});
