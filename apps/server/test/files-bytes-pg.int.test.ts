// PLAN-014 S3, SPEC-014 AC-14 (Postgres half; allowed under the testing hold, SPEC-014 Q15,
// 2026-11-12), E18, E21, E22: the byte protocol on real Postgres advisory and row locks, with the
// real local blob store in a temporary folder. A model can't show a lock that Postgres doesn't
// take, or a statement that reads an old snapshot after waiting; these runs can.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/db/uuidv7.js';
import { postgresCode } from '../src/executor/transaction.js';
import { localBlobStore, type BlobStore } from '../src/files/blob-store.js';
import {
  deleteFiles,
  drainBlobRelease,
  insertCopies,
  insertPreview,
  insertUpload,
  pgFileDb,
  pgFileTx,
  sweep,
  type FileDb,
  type NewFile,
} from '../src/files/bytes.js';
import { cleanupFiles } from '../src/jobs/files.js';
import { syncRepo } from '../src/sync/repo.js';
import { createTestDatabase, type TestDatabase } from './db.js';
import { body } from './files-bytes-model.js';

let db: TestDatabase;
let root: string;
let blobs: BlobStore;
let files: FileDb;
const ada = randomUUID();
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'surface-bytes-pg-'));
  blobs = localBlobStore(root);
  files = pgFileDb(db.pool);
  await inTx(async (client) => {
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await repo.insert('User', {
      id: ada,
      email: 'ada@example.com',
      name: 'Ada',
      displayName: 'Ada',
      syncGroups: [],
    });
    await repo.flush({});
  });
});
afterAll(async () => {
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A transaction left open until `commit()`: to hold its locks while another one runs. */
const held = new Set<pg.PoolClient>();

async function openTx() {
  const client = await db.pool.connect();
  held.add(client);
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  return {
    client,
    tx: pgFileTx(client),
    async commit() {
      held.delete(client);
      await client.query('COMMIT');
      client.release();
    },
  };
}

// A test that fails while holding a transaction open would leave the others waiting on its
// locks: roll it back, so the failure shows at once.
afterEach(async () => {
  for (const client of held) {
    held.delete(client);
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

/** Polls `pg_locks` until some backend waits on a lock of `type`, or fails at the deadline. */
async function untilWaiting(type: 'advisory' | 'transactionid' | 'tuple', timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rowCount } = await db.pool.query(
      'SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = $1',
      [type],
    );
    if ((rowCount ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for a ${type} lock wait`);
    await delay(20);
  }
}

function fileOf(
  temp: { key: string; size: number },
  purpose: NewFile['purpose'],
  extra: Partial<NewFile> = {},
): Omit<NewFile, 'storageKey'> {
  return {
    id: uuidv7(),
    purpose,
    name: 'x',
    mimeType: 'text/plain',
    size: temp.size,
    uploaderId: ada,
    ...extra,
  };
}

async function upload(
  content: string,
  purpose: NewFile['purpose'] = 'attachment',
  extra: Partial<NewFile> = {},
): Promise<{ id: string; key: string }> {
  const temp = await blobs.putStream(body(content));
  const file = fileOf(temp, purpose, extra);
  await files.transaction((tx) => insertUpload(tx, blobs, temp, file));
  return { id: file.id, key: temp.key };
}

const rowsOn = async (key: string) =>
  (await db.pool.query('SELECT id FROM files WHERE storage_key = $1', [key])).rowCount ?? 0;
const released = async (key: string) =>
  ((await db.pool.query('SELECT 1 FROM blob_release WHERE storage_key = $1', [key])).rowCount ??
    0) > 0;
const stored = async (key: string) => (await blobs.stat(key)) !== undefined;

describe('the byte protocol on Postgres (SPEC-014 §4.5, AC-14)', () => {
  it('makes a copy wait for the key lock of a delete of another row on its key, then find the bytes (E18)', async () => {
    // Two rows on one key: the deleter deletes the first; the copy's source is the second, which
    // the deleter never locks. Only the key lock orders them.
    const deleted = await upload('e18');
    const source = await upload('e18');
    expect(source.key).toBe(deleted.key);
    const deleter = await openTx();
    await deleteFiles(deleter.tx, [deleted.id]);
    const file = fileOf({ key: source.key, size: 3 }, 'inline', { issueId: randomUUID() });
    const copy = files.transaction((tx) =>
      insertCopies(tx, blobs, { claims: [], copies: [{ sourceId: source.id, file }] }, silent),
    );
    await untilWaiting('advisory');
    await deleter.commit();
    expect(await copy).toEqual({ unusable: [] });
    // The deleted row's key reached blob_release; the drain keeps the bytes for the two rows.
    expect(await released(source.key)).toBe(true);
    await drainBlobRelease(files, blobs, silent);
    expect(await stored(source.key)).toBe(true);
    expect(await rowsOn(source.key)).toBe(2);
    expect(await released(source.key)).toBe(false);
  });

  it('saves a document’s claim and copies in one transaction, and refuses one naming a file it can’t use (§4.3, E24)', async () => {
    const issueId = randomUUID();
    const pasted = await upload('save pasted', 'inline');
    const first = await upload('save first', 'attachment', { issueId: randomUUID() });
    const second = await upload('save second', 'inline', { issueId: randomUUID() });
    const copies = [first, second].map((source) => ({
      sourceId: source.id,
      file: fileOf({ key: source.key, size: 3 }, 'inline', { issueId }),
    }));
    // Someone else's upload can't be claimed: nothing is written.
    const refused = await files.transaction((tx) =>
      insertCopies(
        tx,
        blobs,
        { claims: [{ id: pasted.id, issueId, uploaderId: randomUUID() }], copies },
        silent,
      ),
    );
    expect(refused).toEqual({ unusable: [pasted.id] });
    const issueRows = () =>
      db.pool.query<{ id: string; storage_key: string }>(
        'SELECT id, storage_key FROM files WHERE issue_id = $1 ORDER BY storage_key',
        [issueId],
      );
    expect((await issueRows()).rows).toEqual([]);

    const saved = await files.transaction((tx) =>
      insertCopies(
        tx,
        blobs,
        { claims: [{ id: pasted.id, issueId, uploaderId: ada }], copies },
        silent,
      ),
    );
    expect(saved).toEqual({ unusable: [] });
    const rows = (await issueRows()).rows;
    expect(rows.map((row) => row.id).sort()).toEqual(
      [pasted.id, ...copies.map((copy) => copy.file.id)].sort(),
    );
    expect(rows.map((row) => row.storage_key).sort()).toEqual(
      [pasted.key, first.key, second.key].sort(),
    );
  });

  it('makes a drain wait for an upload holding the key, and then keep its bytes', async () => {
    const first = await upload('drain race');
    await files.transaction((tx) => deleteFiles(tx, [first.id]));
    expect(await released(first.key)).toBe(true);
    // The same bytes again: renamed and inserted, not yet committed.
    const temp = await blobs.putStream(body('drain race'));
    const uploader = await openTx();
    await insertUpload(uploader.tx, blobs, temp, fileOf(temp, 'inline'));
    const drain = drainBlobRelease(files, blobs, silent);
    await untilWaiting('advisory');
    await uploader.commit();
    // Its statement after the lock saw the upload's commit (READ COMMITTED).
    expect(await drain).toMatchObject({ unlinked: 0, kept: 1 });
    expect(await stored(first.key)).toBe(true);
  });

  it('makes a sweep re-check under the key lock, keeping bytes an upload commits meanwhile', async () => {
    const temp = await blobs.putStream(body('sweep race'));
    const uploader = await openTx();
    await insertUpload(uploader.tx, blobs, temp, fileOf(temp, 'inline'));
    // The bytes are on disk under their key; their row isn't committed: the sweep's first pass
    // sees no row, its locked re-check waits.
    const swept = sweep(files, blobs, new Date(), silent);
    await untilWaiting('advisory');
    await uploader.commit();
    expect((await swept).orphans).toBe(0);
    expect(await stored(temp.key)).toBe(true);
  });

  it('removes bytes an upload renamed before its transaction failed (§4.5 step 2)', async () => {
    const temp = await blobs.putStream(body('failed upload'));
    await expect(
      files.transaction(async (tx) => {
        await insertUpload(tx, blobs, temp, fileOf(temp, 'inline'));
        throw new Error('the insert failed after the rename');
      }),
    ).rejects.toThrow('after the rename');
    expect(await stored(temp.key)).toBe(true);
    expect(await rowsOn(temp.key)).toBe(0);
    expect(await sweep(files, blobs, new Date(), silent)).toMatchObject({ orphans: 1 });
    expect(await stored(temp.key)).toBe(false);
  });

  it('deletes previews before their source and releases both keys; a preview waits for a deleter (E21)', async () => {
    const source = await upload('e21 source', 'attachment', { issueId: randomUUID() });
    const previewTemp = await blobs.putStream(body('e21 preview'));
    await files.transaction((tx) =>
      insertPreview(tx, blobs, previewTemp, {
        ...fileOf(previewTemp, 'preview'),
        previewOf: source.id,
      }),
    );
    // A second preview job, racing a deleter that holds the source row: it waits, then finds
    // the source gone and inserts nothing.
    const deleter = await openTx();
    await deleteFiles(deleter.tx, [source.id]);
    const lateTemp = await blobs.putStream(body('e21 late preview'));
    const late = files.transaction((tx) =>
      insertPreview(tx, blobs, lateTemp, { ...fileOf(lateTemp, 'preview'), previewOf: source.id }),
    );
    await untilWaiting('transactionid');
    await deleter.commit();
    expect(await late).toBe(false);
    await blobs.discard(lateTemp.tempPath);
    expect(await rowsOn(source.key)).toBe(0);
    expect(await rowsOn(previewTemp.key)).toBe(0);
    expect(await released(source.key)).toBe(true);
    expect(await released(previewTemp.key)).toBe(true);
    await drainBlobRelease(files, blobs, silent);
    expect(await stored(source.key)).toBe(false);
    expect(await stored(previewTemp.key)).toBe(false);
  });

  it('refuses to delete a named avatar by its foreign key, inside a savepoint the transaction survives (E22)', async () => {
    const avatar = await upload('e22 avatar', 'avatar');
    await inTx(async (client) => {
      const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
      await repo.update('User', ada, { avatarFileId: avatar.id });
      await repo.flush({});
    });
    await files.transaction(async (tx) => {
      const error = await tx.savepoint(() => deleteFiles(tx, [avatar.id])).catch((e: unknown) => e);
      expect(postgresCode(error)).toBe('23503');
      // Still usable after the rollback to the savepoint.
      expect(await tx.keyInUse(avatar.key)).toBe(true);
    });
    expect(await rowsOn(avatar.key)).toBe(1);
    expect(await released(avatar.key)).toBe(false);
  });
});

describe('files-cleanup on Postgres (SPEC-014 §4.6)', () => {
  it('applies the 24-hour rules, skips rows other transactions hold, and is safe twice at once', async () => {
    const backdate = (id: string, column: 'created_at' | 'detached_at') =>
      db.pool.query(`UPDATE files SET ${column} = now() - interval '25 hours' WHERE id = $1`, [id]);
    const issueId = randomUUID();
    const unclaimed = await upload('cleanup unclaimed', 'inline');
    const young = await upload('cleanup young', 'inline');
    const detached = await upload('cleanup detached', 'attachment', { issueId });
    const attached = await upload('cleanup attached', 'attachment', { issueId });
    const unusedLogo = await upload('cleanup logo', 'logo');
    const held = await upload('cleanup held', 'inline');
    for (const id of [unclaimed.id, detached.id, attached.id, unusedLogo.id, held.id]) {
      await backdate(id, 'created_at');
    }
    await db.pool.query('UPDATE files SET detached_at = now() WHERE id = $1', [detached.id]);
    await backdate(detached.id, 'detached_at');

    // A claim in progress holds `held`: clean-up skips it rather than wait (SKIP LOCKED, E24).
    const claimer = await openTx();
    await claimer.tx.lockFiles([held.id], 'update');
    const now = () => new Date();
    const [first, second] = await Promise.all([
      cleanupFiles({ db: files, blobs, log: silent, now, batch: 2 }),
      cleanupFiles({ db: files, blobs, log: silent, now, batch: 2 }),
    ]);
    await claimer.commit();
    const sum = (k: 'unclaimed' | 'detached' | 'unused') => first[k] + second[k];
    // Earlier tests' rows are young, or named, or gone: only this test's count here.
    expect(sum('unclaimed')).toBe(1);
    expect(sum('detached')).toBe(1);
    expect(sum('unused')).toBe(1);
    const left = await db.pool.query<{ id: string }>('SELECT id FROM files WHERE id = ANY($1)', [
      [unclaimed.id, young.id, detached.id, attached.id, unusedLogo.id, held.id],
    ]);
    expect(left.rows.map((r) => r.id).sort()).toEqual([young.id, attached.id, held.id].sort());
    for (const gone of [unclaimed, detached, unusedLogo])
      expect(await stored(gone.key)).toBe(false);
    expect((await db.pool.query('SELECT 1 FROM blob_release')).rowCount).toBe(0);
  });
});

describe('concurrent protocol runs on Postgres (AC-14)', () => {
  it('never leaves a row without bytes, nor bytes without a row after a final drain and sweep', async () => {
    const contents = ['p', 'q', 'r'];
    const ids: string[] = [];
    const pick = (i: number) => ids[i % Math.max(ids.length, 1)];
    for (let round = 0; round < 6; round++) {
      const work: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        const content = contents[(round + i) % contents.length] ?? 'p';
        switch ((round * 7 + i) % 5) {
          case 0:
          case 1:
            work.push(upload(content, 'inline').then((u) => ids.push(u.id)));
            break;
          case 2: {
            const id = pick(i);
            if (id !== undefined) work.push(files.transaction((tx) => deleteFiles(tx, [id])));
            break;
          }
          case 3:
            work.push(drainBlobRelease(files, blobs, silent));
            break;
          case 4:
            work.push(sweep(files, blobs, new Date(), silent));
            break;
        }
      }
      await Promise.all(work);
      // Under each key's lock: every row's bytes are there.
      const { rows } = await db.pool.query<{ storage_key: string }>(
        'SELECT DISTINCT storage_key FROM files',
      );
      for (const { storage_key: key } of rows) {
        await files.transaction(async (tx) => {
          await tx.lockKeys([key]);
          if (await tx.keyInUse(key)) expect(await stored(key)).toBe(true);
        });
      }
    }
    await drainBlobRelease(files, blobs, silent);
    await sweep(files, blobs, new Date(Date.now() + 2 * 60 * 60 * 1000), silent);
    const named = new Set(
      (await db.pool.query<{ k: string }>('SELECT DISTINCT storage_key AS k FROM files')).rows.map(
        (r) => r.k,
      ),
    );
    const onDisk = new Set<string>();
    for await (const key of blobs.list()) onDisk.add(key);
    expect(onDisk).toEqual(named);
    const temps = [];
    for await (const temp of blobs.listTemps()) temps.push(temp);
    expect(temps).toEqual([]);
  });
});
