// PLAN-014 S3, SPEC-014 AC-15, E15, E21, E22: `files-cleanup` and `files-sweep` against the model
// of Postgres (`files-bytes-model.ts`) on a fake clock, and the local store's listings on a real
// temporary folder.
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localBlobStore } from '../src/files/blob-store.js';
import {
  deleteFiles,
  drainBlobRelease,
  insertPreview,
  insertUpload,
  sweep,
} from '../src/files/bytes.js';
import type { NewFile } from '../src/files/bytes.js';
import { cleanupFiles, fileJobs } from '../src/jobs/files.js';
import { body, MODEL_HOUR, ModelDb, modelBlobStore } from './files-bytes-model.js';

const ADA = '01930000-0000-7000-8000-00000000ada1';

function world() {
  const db = new ModelDb();
  const blobs = modelBlobStore(db);
  let n = 0;
  async function upload(
    content: string,
    purpose: NewFile['purpose'],
    extra: { issueId?: string } = {},
  ): Promise<string> {
    // Ids sort in creation order, like uuidv7.
    const id = `01930000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
    const temp = await blobs.putStream(body(content));
    await db.transaction((tx) =>
      insertUpload(tx, blobs, temp, {
        id,
        purpose,
        name: 'x',
        mimeType: 'text/plain',
        size: temp.size,
        uploaderId: ADA,
        issueId: extra.issueId ?? null,
      }),
    );
    return id;
  }
  async function preview(of: string, content: string): Promise<string> {
    const id = `01930000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
    const temp = await blobs.putStream(body(content));
    await db.transaction((tx) =>
      insertPreview(tx, blobs, temp, {
        id,
        purpose: 'preview',
        name: 'preview.webp',
        mimeType: 'image/webp',
        size: temp.size,
        uploaderId: ADA,
        previewOf: of,
      }),
    );
    return id;
  }
  const detach = (id: string) => db.modelTransaction((tx) => tx.detach(id));
  const name = (id: string) => db.modelTransaction((tx) => tx.name(id));
  const hours = (h: number) => {
    db.clock += h * MODEL_HOUR;
  };
  const cleanup = () => cleanupFiles({ db, blobs, now: () => new Date(db.clock) });
  return { db, blobs, upload, preview, detach, name, hours, cleanup };
}

describe('files-cleanup (SPEC-014 §4.6, AC-15)', () => {
  it('deletes unclaimed uploads 24 hours after upload, and not before (E15)', async () => {
    const w = world();
    const attachment = await w.upload('a', 'attachment');
    const inline = await w.upload('b', 'inline');
    const claimed = await w.upload('c', 'attachment', { issueId: 'issue-1' });
    w.hours(23);
    const late = await w.upload('d', 'inline');
    expect(await w.cleanup()).toMatchObject({ unclaimed: 0 });
    expect(w.db.rows.size).toBe(4);

    w.hours(1.5); // the first three are 24.5 h old, `late` 1.5 h
    expect(await w.cleanup()).toMatchObject({ unclaimed: 2, unlinked: 2, kept: 0 });
    expect([...w.db.rows.keys()].sort()).toEqual([claimed, late].sort());
    expect(w.db.rows.has(attachment) || w.db.rows.has(inline)).toBe(false);
    expect(w.blobs.keys()).toHaveLength(2);
  });

  it('deletes an attachment 24 hours after it was detached, not 24 hours after upload (E8)', async () => {
    const w = world();
    const early = await w.upload('a', 'attachment', { issueId: 'issue-1' });
    const late = await w.upload('b', 'attachment', { issueId: 'issue-1' });
    w.hours(30);
    await w.detach(early);
    w.hours(23);
    await w.detach(late);
    expect(await w.cleanup()).toMatchObject({ detached: 0 });
    w.hours(2);
    expect(await w.cleanup()).toMatchObject({ detached: 1 });
    expect([...w.db.rows.keys()]).toEqual([late]);
  });

  it('deletes avatars and logos nobody names after 24 hours, and keeps those in use', async () => {
    const w = world();
    const unused = await w.upload('a', 'avatar');
    const current = await w.upload('b', 'avatar');
    const logo = await w.upload('c', 'logo');
    const recent = await w.upload('d', 'logo');
    await w.name(current);
    w.hours(25);
    const fresh = await w.upload('e', 'avatar');
    // `recent` is as old as the others: only `fresh` is too young.
    expect(await w.cleanup()).toMatchObject({ unused: 3, skipped: 0 });
    expect([...w.db.rows.keys()].sort()).toEqual([current, fresh].sort());
    expect(w.db.rows.has(unused) || w.db.rows.has(logo) || w.db.rows.has(recent)).toBe(false);
  });

  it('deletes previews explicitly before their source, and their keys reach blob_release (E21)', async () => {
    const w = world();
    const source = await w.upload('a', 'attachment', { issueId: 'issue-1' });
    const preview = await w.preview(source, 'p');
    // A preview sharing its bytes with another row: released, but kept by the drain.
    const twin = await w.upload('q', 'inline', { issueId: 'issue-2' });
    const sharing = await w.preview(source, 'q');
    await w.detach(source);
    w.hours(25);
    const order: string[] = [];
    const step = w.db.step;
    w.db.step = (label) => {
      order.push(label);
      return step(label);
    };
    const counts = await w.cleanup();
    expect(counts).toMatchObject({ detached: 1, previews: 2, unlinked: 2, kept: 1 });
    expect([...w.db.rows.keys()]).toEqual([twin]);
    expect(w.db.rows.has(preview) || w.db.rows.has(sharing)).toBe(false);
    // Two deletes: the previews, then the source (RESTRICT refuses the reverse).
    expect(order.filter((label) => label === 'deleteFiles')).toHaveLength(2);
    expect(w.blobs.keys()).toHaveLength(1);
    expect(w.db.released.size).toBe(0);
  });

  it('keeps the bytes of a released key another row still names (E2)', async () => {
    const w = world();
    await w.upload('a', 'attachment');
    const kept = await w.upload('a', 'attachment', { issueId: 'issue-1' });
    w.hours(25);
    expect(await w.cleanup()).toMatchObject({ unclaimed: 1, unlinked: 0, kept: 1 });
    expect([...w.db.rows.keys()]).toEqual([kept]);
    expect(w.blobs.keys()).toHaveLength(1);
  });

  it('skips an avatar a user names after the check, keeps the others’ deletes, and keeps it next run (E22)', async () => {
    const w = world();
    const avatar = await w.upload('a', 'avatar');
    const other = await w.upload('b', 'avatar');
    const upload = await w.upload('c', 'inline');
    w.hours(25);
    // `user.updateProfile` commits between the candidates' check and the delete.
    const step = w.db.step;
    let named = false;
    w.db.step = (label) => {
      if (label === 'deleteFiles' && !named) {
        named = true;
        w.db.named.add(avatar);
      }
      return step(label);
    };
    expect(await w.cleanup()).toMatchObject({ unused: 1, unclaimed: 1, skipped: 1 });
    expect([...w.db.rows.keys()]).toEqual([avatar]);
    expect(w.db.rows.has(other) || w.db.rows.has(upload)).toBe(false);
    // Its key never reached `blob_release`: the bytes stay.
    expect(w.blobs.keys()).toHaveLength(1);

    w.db.step = step;
    expect(await w.cleanup()).toMatchObject({ unused: 0, skipped: 0 });
    expect([...w.db.rows.keys()]).toEqual([avatar]);
  });

  it('runs twice at once without failing or deleting a row twice', async () => {
    const w = world();
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await w.upload(`f${i}`, 'attachment'));
    w.hours(25);
    // Each statement yields, so the two runs interleave; small batches page through the rows.
    w.db.step = () => new Promise((resolve) => setImmediate(resolve));
    const run = () =>
      cleanupFiles({ db: w.db, blobs: w.blobs, now: () => new Date(w.db.clock), batch: 2 });
    const [first, second] = await Promise.all([run(), run()]);
    expect((first?.unclaimed ?? 0) + (second?.unclaimed ?? 0)).toBe(7);
    expect((first?.unlinked ?? 0) + (second?.unlinked ?? 0)).toBe(7);
    expect(w.db.rows.size).toBe(0);
    expect(w.blobs.keys()).toEqual([]);
    expect(w.db.released.size).toBe(0);
  });

  it('logs its counts as `files cleanup`, never a name or key', async () => {
    const w = world();
    await w.upload('secret name', 'attachment');
    w.hours(25);
    const lines: { object: object; message: string }[] = [];
    const jobs = fileJobs(
      { db: w.db, blobs: w.blobs, now: () => new Date(w.db.clock) },
      { info: (object: object, message: string) => void lines.push({ object, message }) },
    );
    await jobs.cleanup('files-cleanup');
    expect(lines).toEqual([
      {
        message: 'files cleanup',
        object: {
          queue: 'files-cleanup',
          unclaimed: 1,
          detached: 0,
          unused: 0,
          previews: 0,
          skipped: 0,
          unlinked: 1,
          kept: 0,
        },
      },
    ]);
  });
});

describe('the blob_release drain (SPEC-014 §4.5 step 4)', () => {
  it('unlinks only keys no row names, and forgets every key it looked at', async () => {
    const w = world();
    const gone = await w.upload('a', 'attachment', { issueId: 'issue-1' });
    await w.upload('b', 'attachment', { issueId: 'issue-1' });
    await w.db.transaction((tx) => deleteFiles(tx, [gone]));
    // A key released by a delete of one of two rows sharing it.
    for (const key of w.blobs.keys()) w.db.released.add(key);
    // A delete never unlinks: both keys still have bytes.
    expect(w.blobs.keys()).toHaveLength(2);
    expect(await drainBlobRelease(w.db, w.blobs, 1)).toEqual({ unlinked: 1, kept: 1 });
    expect(w.blobs.keys()).toHaveLength(1);
    expect(w.db.released.size).toBe(0);
  });
});

describe('files-sweep (SPEC-014 §4.5 step 5)', () => {
  it('removes bytes no row names and temporary files untouched for an hour', async () => {
    const w = world();
    await w.upload('a', 'attachment');
    // Bytes renamed by an upload whose transaction then failed: no row.
    const orphan = await w.blobs.putStream(body('orphan'));
    await w.blobs.commit(orphan.tempPath, orphan.key);
    const stale = await w.blobs.putStream(body('crashed upload'));
    w.hours(1.5);
    const live = await w.blobs.putStream(body('upload in progress'));
    expect(await sweep(w.db, w.blobs, new Date(w.db.clock), 1)).toEqual({ orphans: 1, temps: 1 });
    expect(w.blobs.keys()).toHaveLength(1);
    expect(w.blobs.keys()).not.toContain(orphan.key);
    expect(w.blobs.temps()).toEqual([live.tempPath]);
    expect(w.blobs.temps()).not.toContain(stale.tempPath);
  });
});

describe('the local store’s listings (sweep input)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('lists every stored key and the temporary files with their last write, nothing else', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'surface-sweep-'));
    const blobs = localBlobStore(root);
    // Nothing stored yet: no folders, no error.
    const empty: string[] = [];
    for await (const key of blobs.list()) empty.push(key);
    expect(empty).toEqual([]);

    const one = await blobs.putStream(body('one'));
    await blobs.commit(one.tempPath, one.key);
    const two = await blobs.put(Buffer.from('two'));
    const temp = await blobs.putStream(body('three'));
    const old = new Date(Date.now() - 2 * MODEL_HOUR);
    await utimes(temp.tempPath, old, old);
    // Strangers are never listed: a crashed `put`'s leftover, a file in the temporary folder.
    await writeFile(path.join(root, ...one.key.split('/')) + '.x.tmp', 'junk');
    await writeFile(path.join(root, 'tmp', 'notes.txt'), 'junk');

    const keys: string[] = [];
    for await (const key of blobs.list()) keys.push(key);
    expect(keys.sort()).toEqual([one.key, two].sort());
    const temps = [];
    for await (const entry of blobs.listTemps()) temps.push(entry);
    expect(temps).toEqual([{ tempPath: temp.tempPath, modifiedAt: old }]);

    // Deleting while listing is allowed.
    for await (const key of blobs.list()) await blobs.delete(key);
    expect(await blobs.stat(one.key)).toBeUndefined();
  });
});
