import { afterAll, describe, expect, it } from 'vitest';
import type { PendingRecord, QueueClaim, StoredChange, SyncStorage } from '../src/storage/types.js';
import { QueueFencedError, StorageFencedError } from '../src/storage/types.js';
import { debugRow, id, noteRow } from './support/models.js';
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
const AT = '2026-11-12T10:00:00.000Z';
/** An archive carries the row with `archivedAt` set, an unarchive with it cleared (v0.7). */
const change = (
  kind: 'archive' | 'unarchive' | 'delete',
  version: number,
  n: number,
  fields: Record<string, unknown> = {},
): StoredChange =>
  kind === 'delete'
    ? { kind, model: 'DebugItem', version, id: id(n) }
    : {
        kind,
        model: 'DebugItem',
        version,
        row: debugRow(n, { archivedAt: kind === 'archive' ? AT : null, ...fields }),
      };

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
      { row: debugRow(2, { archivedAt: AT }), archived: true },
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

  // SPEC-011 §5.5: archive and unarchive are an upsert plus the flag.
  it('stores the row an archive or unarchive carries, even one it never stored', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start());
    await storage.applyChanges(
      generation,
      [change('unarchive', 11, 7, { title: 'Restored' }), change('archive', 12, 8)],
      12,
    );
    expect(await readAll(storage)).toEqual([
      { row: debugRow(7, { title: 'Restored' }), archived: false },
      { row: debugRow(8, { archivedAt: AT }), archived: true },
    ]);
    await storage.close();
  });

  it('keeps an archived row archived through an update, and restores a deleted row from a newer unarchive', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start(10));
    await storage.writeBootstrapRows(generation, rows(1, 2));
    await storage.applyChanges(
      generation,
      [
        change('archive', 11, 1),
        upsert(12, 1, { title: 'Edited', archivedAt: AT }),
        change('delete', 13, 2),
        change('unarchive', 14, 2, { title: 'Back' }),
      ],
      14,
    );
    expect(await readAll(storage)).toEqual([
      { row: debugRow(1, { title: 'Edited', archivedAt: AT }), archived: true },
      { row: debugRow(2, { title: 'Back' }), archived: false },
    ]);
    await storage.close();
  });

  it('never lets an older archive or unarchive overwrite a newer update or delete', async () => {
    const storage = await open(uniqueName());
    const generation = await storage.beginBootstrap(start(10));
    await storage.writeBootstrapRows(generation, rows(1, 2, 3));
    // The fast tab is at 20: row 1 updated at 15, row 2 deleted at 16, row 3 archived at 17.
    await storage.applyChanges(
      generation,
      [upsert(15, 1, { title: 'Newer' }), change('delete', 16, 2), change('archive', 17, 3)],
      20,
    );
    // The slow tab replays 11–13: an older archive of row 1, an older unarchive of row 2 (the
    // tombstone keeps it deleted) and an older unarchive of row 3.
    await storage.applyChanges(
      generation,
      [change('archive', 11, 1), change('unarchive', 12, 2), change('unarchive', 13, 3)],
      13,
    );
    expect(await readAll(storage)).toEqual([
      { row: debugRow(1, { title: 'Newer' }), archived: false },
      { row: debugRow(3, { archivedAt: AT }), archived: true },
    ]);
    expect((await storage.readMeta())?.lastSyncId).toBe(20);
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

  describe('mutation queue (PLAN-002 S8)', () => {
    const CLIENT = '0190f4c4-0000-7000-8000-0000000000a1';
    const OTHER = '0190f4c4-0000-7000-8000-0000000000b2';
    const entry = (seq: number, clientId = CLIENT): PendingRecord => ({
      clientId,
      seq,
      op: 'debug.touch',
      input: { id: id(seq) },
      at: '2026-11-06T10:00:00.000Z',
    });
    /** `fresh: null`: adopt only. */
    const claim = (
      owner: string,
      now: number,
      more: { clientId?: string; fresh?: string | null } = {},
    ): QueueClaim => {
      const fresh = more.fresh === undefined ? OTHER : more.fresh;
      return {
        owner,
        now,
        leaseUntil: now + 15_000,
        ...(fresh === null ? {} : { fresh }),
        ...(more.clientId === undefined ? {} : { clientId: more.clientId }),
      };
    };

    it('claims a named queue, stores entries in seq order, and keeps them through a re-bootstrap', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      expect(await storage.claimQueue(claim('tab-a', 0, { clientId: CLIENT }))).toEqual({
        client: { clientId: CLIENT, nextSeq: 1, owner: 'tab-a', leaseUntil: 15_000 },
        pending: [],
      });
      await storage.writeQueue({
        clientId: CLIENT,
        owner: 'tab-a',
        nextSeq: 4,
        put: [entry(3), entry(1), entry(2)],
      });
      await storage.writeQueue({
        clientId: CLIENT,
        owner: 'tab-a',
        remove: [1],
        put: [{ ...entry(2), lastSyncId: 40 }],
      });
      await storage.beginBootstrap(start());
      await storage.clear();

      const queue = await storage.readQueue();
      expect(queue.clients).toEqual([
        { clientId: CLIENT, nextSeq: 4, owner: 'tab-a', leaseUntil: 15_000 },
      ]);
      expect(queue.pending).toEqual([{ ...entry(2), lastSyncId: 40 }, entry(3)]);
      await storage.close();
    });

    it('fences the old owner once another tab claims its queue', async () => {
      const name = uniqueName();
      const a = await backend.open(name, MODELS);
      const b = await backend.open(name, MODELS);
      await a.claimQueue(claim('tab-a', 0, { clientId: CLIENT }));
      await b.claimQueue(claim('tab-b', 0, { clientId: CLIENT }));
      await expect(
        a.writeQueue({ clientId: CLIENT, owner: 'tab-a', put: [entry(1)] }),
      ).rejects.toBeInstanceOf(QueueFencedError);
      await b.writeQueue({ clientId: CLIENT, owner: 'tab-b', put: [entry(1)] });
      expect((await b.readQueue()).pending).toEqual([entry(1)]);
      await a.close();
      await b.close();
    });

    it('without a named queue, adopts one whose lease ran out, else starts a new one', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      await storage.claimQueue(claim('tab-a', 0, { clientId: CLIENT })); // lease until 15 s
      await storage.writeQueue({ clientId: CLIENT, owner: 'tab-a', put: [entry(1)] });
      const early = await storage.claimQueue(claim('tab-b', 10_000));
      expect(early?.client).toMatchObject({ clientId: OTHER, owner: 'tab-b', nextSeq: 1 });
      const late = await storage.claimQueue(claim('tab-c', 20_000));
      expect(late?.client).toMatchObject({ clientId: CLIENT, owner: 'tab-c' });
      await storage.close();
    });

    it('adopts an abandoned queue with mutations before an empty one, and returns them with the claim', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      const EMPTY = '0190f4c4-0000-7000-8000-000000000001'; // sorts before CLIENT
      await storage.claimQueue(claim('tab-a', 0, { clientId: EMPTY }));
      await storage.claimQueue(claim('tab-b', 0, { clientId: CLIENT }));
      await storage.writeQueue({
        clientId: CLIENT,
        owner: 'tab-b',
        nextSeq: 3,
        put: [entry(1), entry(2)],
      });

      const adopted = await storage.claimQueue(claim('tab-c', 20_000));
      expect(adopted).toEqual({
        client: { clientId: CLIENT, nextSeq: 3, owner: 'tab-c', leaseUntil: 35_000 },
        pending: [entry(1), entry(2)],
      });
      await storage.close();
    });

    it('leaves an expired queue with nothing pending to its tab, and forgets abandoned empty ones (review M1)', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      const THIRD = '0190f4c4-0000-7000-8000-0000000000c3';
      const FOURTH = '0190f4c4-0000-7000-8000-0000000000d4';
      const ids = async () => (await storage.readQueue()).clients.map((c) => c.clientId);
      await storage.claimQueue(claim('tab-a', 0, { clientId: CLIENT })); // empty, lease until 15 s

      // Its tab may only be frozen: adopting an empty queue gains nothing and fences it.
      const b = await storage.claimQueue(claim('tab-b', 20_000));
      expect(b?.client.clientId).toBe(OTHER);
      expect(await ids()).toEqual([CLIENT, OTHER]);

      // B closes cleanly (lease 0): its empty queue is forgotten at the next claim.
      await storage.writeQueue({ clientId: OTHER, owner: 'tab-b', leaseUntil: 0 });
      await storage.claimQueue(claim('tab-c', 21_000, { fresh: THIRD }));
      expect(await ids()).toEqual([CLIENT, THIRD]);

      // A day after their leases ended, empty queues are forgotten too.
      await storage.claimQueue(claim('tab-d', 36_000 + 86_400_000 + 1, { fresh: FOURTH }));
      expect(await ids()).toEqual([FOURTH]);
      await storage.close();
    });

    it('without `fresh`, only adopts: nothing to adopt claims nothing (review M1)', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      expect(await storage.claimQueue(claim('tab-a', 0, { fresh: null }))).toBeUndefined();
      expect((await storage.readQueue()).clients).toEqual([]);

      await storage.claimQueue(claim('tab-b', 0, { clientId: CLIENT }));
      await storage.writeQueue({ clientId: CLIENT, owner: 'tab-b', put: [entry(1)] });
      const adopted = await storage.claimQueue(claim('tab-c', 20_000, { fresh: null }));
      expect(adopted).toMatchObject({
        client: { clientId: CLIENT, owner: 'tab-c' },
        pending: [entry(1)],
      });
      await storage.close();
    });

    it('cannot write a queue nobody claimed', async () => {
      const storage = await backend.open(uniqueName(), MODELS);
      await expect(
        storage.writeQueue({ clientId: CLIENT, owner: 'tab-a', put: [entry(1)] }),
      ).rejects.toBeInstanceOf(QueueFencedError);
      expect((await storage.readQueue()).pending).toEqual([]);
      await storage.close();
    });
  });
});

// SPEC-011 §5.3 steps 3–4, §5.4, E18, E23, E24, E25; PLAN-011 S5b: content rows and the hydrated set.
describe.each(BACKENDS)('$name content storage', (backend) => {
  const CONTENT_MODELS = ['DebugItem', 'Note'];
  const REFS = [{ model: 'Note', field: 'itemId', parent: 'DebugItem' }];
  const open = (name: string) => backend.open(name, CONTENT_MODELS, REFS);
  const note = (version: number, n: number, item: number, body?: string): StoredChange => ({
    kind: 'upsert',
    model: 'Note',
    version,
    row: noteRow(n, item, body),
  });
  const noteGone = (version: number, n: number): StoredChange => ({
    kind: 'delete',
    model: 'Note',
    version,
    id: id(n),
  });
  /** A replica at id 10 holding items 1 and 2, nothing hydrated. */
  async function seeded(name = uniqueName()) {
    const storage = await open(name);
    const generation = await storage.beginBootstrap(start());
    await storage.writeBootstrapRows(generation, rows(1, 2));
    await storage.finishBootstrap(generation);
    return { storage, generation, name };
  }
  const answer = (version: number, parents: number[], notes: [number, number, string?][]) => ({
    parents: parents.map(id),
    rows: notes.map(([n, item, body]) => ({
      model: 'Note',
      row: noteRow(n, item, body),
      archived: false,
    })),
    version,
    openedAt: 1,
  });
  /** What the stored generation holds for `item`. */
  const content = async (storage: SyncStorage, item: number) => {
    const meta = await storage.readMeta();
    if (meta === undefined) return { hydrated: false, rows: [] };
    const read = await storage.readContent(meta.generation, id(item));
    return {
      hydrated: read.hydrated,
      rows: read.records.map((r) => [r.row.id, r.row['body'], r.version]).sort(),
    };
  };

  it('stores an answer’s rows and marks its parents hydrated together', async () => {
    const { storage, generation } = await seeded();
    await storage.writeContent(
      generation,
      answer(
        12,
        [1],
        [
          [11, 1],
          [12, 1],
        ],
      ),
    );
    expect(await content(storage, 1)).toEqual({
      hydrated: true,
      rows: [
        [id(11), 'Note 11', 12],
        [id(12), 'Note 12', 12],
      ],
    });
    expect(await storage.readHydrated()).toEqual([id(1)]);
    expect(await content(storage, 2)).toEqual({ hydrated: false, rows: [] });
    await storage.close();
  });

  it('writes neither rows nor marks for a fenced generation', async () => {
    const { storage, generation, name } = await seeded();
    const other = backend.name === 'memory' ? storage : await open(name);
    const next = await other.beginBootstrap(start(20));
    await other.writeBootstrapRows(next, rows(1));
    await other.finishBootstrap(next);
    await expect(
      storage.writeContent(generation, answer(12, [1], [[11, 1]])),
    ).rejects.toBeInstanceOf(StorageFencedError);
    // Nor does it read another generation's content: it may lag the fenced tab (PLAN-011 S5b).
    await expect(storage.readContent(generation, id(1))).rejects.toBeInstanceOf(StorageFencedError);
    expect(await content(other, 1)).toEqual({ hydrated: false, rows: [] });
    await storage.close();
    if (other !== storage) await other.close();
  });

  it('skips a parent it doesn’t hold or holds as a tombstone, with its rows (E23)', async () => {
    const { storage, generation } = await seeded();
    await storage.applyChanges(generation, [change('delete', 11, 2)], 11);
    await storage.writeContent(
      generation,
      answer(
        12,
        [1, 2, 3],
        [
          [11, 1],
          [21, 2],
          [31, 3],
        ],
      ),
    );
    expect(await storage.readHydrated()).toEqual([id(1)]);
    expect(await content(storage, 2)).toEqual({ hydrated: false, rows: [] });
    expect(await content(storage, 3)).toEqual({ hydrated: false, rows: [] });
    await storage.close();
  });

  it('keeps content upserts only for hydrated parents (§5.3 step 4)', async () => {
    const { storage, generation } = await seeded();
    await storage.writeContent(generation, answer(11, [1], []));
    await storage.applyChanges(generation, [note(12, 11, 1), note(13, 21, 2)], 13);
    expect(await content(storage, 1)).toEqual({ hydrated: true, rows: [[id(11), 'Note 11', 12]] });
    expect(await content(storage, 2)).toEqual({ hydrated: false, rows: [] });
    await storage.close();
  });

  it('hydrates the parents a batch names, before its content (an Issue I, §5.3 step 5)', async () => {
    const { storage, generation } = await seeded();
    await storage.applyChanges(generation, [upsert(11, 3), note(12, 31, 3)], 12, undefined, [
      id(3),
    ]);
    expect(await content(storage, 3)).toEqual({ hydrated: true, rows: [[id(31), 'Note 31', 12]] });
    await storage.close();
  });

  it('stores a content D as a tombstone, so an older answer can’t bring the row back (E25)', async () => {
    const { storage, generation } = await seeded();
    await storage.applyChanges(generation, [noteGone(14, 11)], 14);
    await storage.writeContent(
      generation,
      answer(
        12,
        [1],
        [
          [11, 1],
          [12, 1],
        ],
      ),
    );
    expect(await content(storage, 1)).toEqual({ hydrated: true, rows: [[id(12), 'Note 12', 12]] });
    await storage.close();
  });

  it('never lets an answer overwrite a newer row', async () => {
    const { storage, generation } = await seeded();
    await storage.writeContent(generation, answer(11, [1], []));
    await storage.applyChanges(generation, [note(14, 11, 1, 'Newer')], 14);
    await storage.writeContent(generation, answer(12, [1], [[11, 1, 'Older']]));
    expect(await content(storage, 1)).toEqual({ hydrated: true, rows: [[id(11), 'Newer', 14]] });
    await storage.close();
  });

  it('drops the content and mark of a parent a batch leaves deleted, and keeps them across D+U (E24)', async () => {
    const { storage, generation } = await seeded();
    await storage.writeContent(
      generation,
      answer(
        11,
        [1, 2],
        [
          [11, 1],
          [21, 2],
        ],
      ),
    );
    await storage.applyChanges(generation, [change('delete', 12, 1), upsert(13, 1)], 13);
    expect(await content(storage, 1)).toEqual({ hydrated: true, rows: [[id(11), 'Note 11', 11]] });
    await storage.applyChanges(generation, [change('delete', 14, 2)], 14);
    expect(await content(storage, 2)).toEqual({ hydrated: false, rows: [] });
    expect(await storage.readHydrated()).toEqual([id(1)]);
    await storage.close();
  });

  it('shares the hydrated set between tabs: one tab’s hydration keeps the other’s packets (E18)', async () => {
    const { storage: tabA, generation, name } = await seeded();
    const tabB = backend.name === 'memory' ? tabA : await open(name);
    await tabA.writeContent(generation, answer(11, [1], [[11, 1]]));
    await tabB.applyChanges(generation, [note(12, 12, 1)], 12);
    expect(await content(tabA, 1)).toEqual({
      hydrated: true,
      rows: [
        [id(11), 'Note 11', 11],
        [id(12), 'Note 12', 12],
      ],
    });
    expect(await tabB.readHydrated()).toEqual([id(1)]);
    await tabA.close();
    if (tabB !== tabA) await tabB.close();
  });

  it('clears the hydrated set and content on re-bootstrap and resync (§5.3 step 7)', async () => {
    const { storage, generation } = await seeded();
    await storage.writeContent(generation, answer(11, [1], [[11, 1]]));
    const next = await storage.beginBootstrap(start(20));
    await storage.writeBootstrapRows(next, rows(1));
    await storage.finishBootstrap(next);
    expect(await content(storage, 1)).toEqual({ hydrated: false, rows: [] });
    await storage.writeContent(next, answer(21, [1], [[11, 1]]));
    await storage.clear();
    expect(await storage.readHydrated()).toEqual([]);
    expect(await content(storage, 1)).toEqual({ hydrated: false, rows: [] });
    await storage.close();
  });
});
