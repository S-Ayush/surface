// PLAN-014 S4a for PLAN-015, SPEC-015 AC-5, E7, E8 (§4.5 "Bytes"): an issue purge deletes its
// `files` rows and records their keys in `blob_release` in its own transaction, and never touches
// bytes. Only `files-cleanup` removes them, after commit, for released keys no row names. A crash
// after the purge commits still ends with the bytes removed by the next run, and an Admin's purge
// works exactly like the job's. Model of Postgres and a fake blob store (`files-bytes-model.ts`).
import { randomUUID } from 'node:crypto';
import { systemActor, userActor, type Actor } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { insertPreview, insertUpload } from '../src/files/bytes.js';
import { createIssue } from '../src/handlers/issues/core.js';
import { ATTACHMENT_PURGE_STEPS } from '../src/issues/purge-steps.js';
import { purgeIssue } from '../src/issues/purge.js';
import { cleanupFiles } from '../src/jobs/files.js';
import { body, MODEL_HOUR, ModelDb, modelBlobStore } from './files-bytes-model.js';
import { ADA_ID, memoryIssues, NOW } from './support/memory-issues.js';
import { scriptedDb } from './support/scripted-db.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const fileId = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A deleted issue with two attachment files (one with a preview), and a third file of another issue sharing bytes with the second. */
async function world() {
  const m = memoryIssues();
  const issue = await createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
  });
  // Deleted 31 days ago: due for the job, and an Admin may purge it any time.
  const deletedAt = new Date(NOW.getTime() - 31 * 24 * MODEL_HOUR);
  m.issues.set(issue.id, { ...issue, deletedAt, deletedById: ADA_ID });
  const other = randomUUID();

  const db = new ModelDb();
  const blobs = modelBlobStore(db);
  const upload = async (id: string, issueId: string, content: string) => {
    const temp = await blobs.putStream(body(content));
    await db.transaction((tx) =>
      insertUpload(tx, blobs, temp, {
        id,
        purpose: 'attachment',
        name: 'x.bin',
        mimeType: 'application/octet-stream',
        size: temp.size,
        uploaderId: ADA_ID,
        issueId,
      }),
    );
  };
  await upload(fileId(1), issue.id, 'first');
  await upload(fileId(2), issue.id, 'shared');
  await upload(fileId(3), other, 'shared');
  const temp = await blobs.putStream(body('preview'));
  await db.transaction((tx) =>
    insertPreview(tx, blobs, temp, {
      id: fileId(4),
      purpose: 'preview',
      name: 'preview.webp',
      mimeType: 'image/webp',
      size: temp.size,
      uploaderId: ADA_ID,
      previewOf: fileId(1),
    }),
  );
  // What the files step reads from Postgres: the issue's rows by `issue_id`.
  const pg = scriptedDb(
    {
      attachments: [],
      files: [
        { id: fileId(1), issue_id: issue.id },
        { id: fileId(2), issue_id: issue.id },
        { id: fileId(3), issue_id: other },
      ],
    },
    { now: NOW },
  );
  const keyOf = (id: string) => db.rows.get(id)?.storageKey ?? '';
  const keys = { first: keyOf(fileId(1)), shared: keyOf(fileId(2)), preview: keyOf(fileId(4)) };

  /** `issue.purge` as `actor`, in one model transaction; `crash` throws after the steps ran. */
  const purge = (actor: Actor, crash = false) =>
    db.modelTransaction(async (tx) => {
      const purged = await purgeIssue(
        { ...m.purge({ actor, now: NOW, steps: ATTACHMENT_PURGE_STEPS }), tx: pg.db, files: tx },
        issue.id,
      );
      if (crash) throw new Error('crash before commit');
      return purged;
    });
  const cleanup = () => {
    db.clock += MODEL_HOUR;
    return cleanupFiles({ db, blobs, log: quiet, now: () => new Date(db.clock) });
  };
  return { db, blobs, keys, purge, cleanup };
}

const admin = userActor({ userId: ADA_ID, role: 'admin', memberships: [] });

describe('purge and file bytes (SPEC-015 AC-5)', () => {
  it.each([
    ['the trash-purge job', systemActor()],
    ['an Admin', admin],
  ] as const)(
    '%s: the purge releases the keys and keeps the bytes; files-cleanup removes those no row names',
    async (_who, actor) => {
      const w = await world();
      await w.purge(actor);
      expect([...w.db.rows.keys()]).toEqual([fileId(3)]);
      expect([...w.db.released].sort()).toEqual(
        [w.keys.first, w.keys.shared, w.keys.preview].sort(),
      );
      // Nothing unlinked by the purge itself.
      expect(w.blobs.keys().sort()).toEqual([w.keys.first, w.keys.shared, w.keys.preview].sort());

      const run = await w.cleanup();
      expect(run).toMatchObject({ unlinked: 2, kept: 1, failed: 0 });
      // The shared key stays: another issue's file still names it (E2).
      expect(w.blobs.keys()).toEqual([w.keys.shared]);
      expect(w.db.released.size).toBe(0);
    },
  );

  it('a crash after the purge commits, before any clean-up, still ends with the bytes removed (E7)', async () => {
    const w = await world();
    await w.purge(admin);
    // The process dies here: no drain ran. The keys are committed in `blob_release`.
    expect(w.db.released.size).toBe(3);
    expect(w.db.open).toBe(0);
    // After the restart, the next scheduled run drains them.
    await w.cleanup();
    expect(w.blobs.keys()).toEqual([w.keys.shared]);
    expect(w.db.released.size).toBe(0);
  });

  it('a crash before the purge commits leaves every row, key and byte as it was', async () => {
    const w = await world();
    await expect(w.purge(admin, true)).rejects.toThrow('crash before commit');
    expect(w.db.rows.size).toBe(4);
    expect(w.db.released.size).toBe(0);
    await w.cleanup();
    expect(w.blobs.keys()).toHaveLength(3);
  });
});
