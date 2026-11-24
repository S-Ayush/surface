// PLAN-014 S3, SPEC-014 AC-14 (model half), E2, E18, E21: the byte protocol of `files/bytes.ts`
// under any interleaving of upload, document save (claims and copies), preview insert, claim,
// detach, avatar naming, clean-up, purge, drain and sweep. The protocol's own code runs against `files-bytes-model.ts` (a model of
// Postgres's locks and READ COMMITTED) and an in-memory blob store, with a fast-check scheduler
// choosing which transaction moves next at every statement. After every step no committed row
// names missing bytes; once everything has run, a final drain and sweep leave no bytes without a
// row, no temporary file and an empty `blob_release`. No transaction is left waiting (no deadlock).
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import {
  deleteFiles,
  drainBlobRelease,
  FileBytesMissing,
  insertCopies,
  insertPreview,
  insertUpload,
  sweep,
} from '../src/files/bytes.js';
import { cleanupFiles } from '../src/jobs/files.js';
import { body, MODEL_HOUR, ModelDb, modelBlobStore, type ModelRow } from './files-bytes-model.js';

// Few contents, so keys are shared often (E2): two uploads of `a`, a copy and a preview of `a`.
const CONTENT = fc.constantFrom('a', 'b', 'c');
const ISSUE = fc.constantFrom('issue-1', 'issue-2');
const PICK = fc.nat(20);

const OPERATION = fc.oneof(
  {
    arbitrary: fc.record({
      op: fc.constant('upload' as const),
      content: CONTENT,
      purpose: fc.constantFrom('attachment' as const, 'inline' as const, 'avatar' as const),
    }),
    weight: 3,
  },
  // A saved document (§4.3): claims an unclaimed inline upload and copies two visible files.
  fc.record({
    op: fc.constant('save' as const),
    claim: PICK,
    sources: fc.tuple(PICK, PICK),
    issue: ISSUE,
  }),
  fc.record({ op: fc.constant('preview' as const), pick: PICK, content: CONTENT }),
  fc.record({ op: fc.constant('claim' as const), pick: PICK, issue: ISSUE }),
  fc.record({ op: fc.constant('detach' as const), pick: PICK }),
  fc.record({ op: fc.constant('name' as const), pick: PICK }),
  fc.record({ op: fc.constant('unname' as const), pick: PICK }),
  fc.record({ op: fc.constant('purge' as const), issue: ISSUE }),
  fc.record({ op: fc.constant('cleanup' as const) }),
  fc.record({ op: fc.constant('drain' as const) }),
  fc.record({ op: fc.constant('sweep' as const) }),
  fc.record({ op: fc.constant('advance' as const), hours: fc.constantFrom(1, 2, 25) }),
);
type Operation = typeof OPERATION extends fc.Arbitrary<infer T> ? T : never;

const UPLOADER = '01930000-0000-7000-8000-00000000ada1';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A document refused because a file it names can't be used: its transaction rolls back. */
class Refused extends Error {}

/** Runs microtasks and Node's ticks to the end: every transaction that can move has asked. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function world() {
  const db = new ModelDb();
  const blobs = modelBlobStore(db);
  const violations: string[] = [];

  /** No committed row names bytes that aren't there (§4.9, AC-14). */
  const check = () => {
    const stored = new Set(blobs.keys());
    for (const row of db.rows.values()) {
      if (!stored.has(row.storageKey)) violations.push(`row ${row.id} names missing bytes`);
    }
  };

  const pick = (n: number, keep: (row: ModelRow) => boolean = () => true) => {
    const rows = [...db.rows.values()].filter(keep);
    return rows.length === 0 ? undefined : rows[n % rows.length];
  };

  async function upload(content: string, purpose: 'attachment' | 'inline' | 'avatar') {
    const temp = await blobs.putStream(body(content));
    try {
      await db.transaction((tx) =>
        insertUpload(tx, blobs, temp, {
          id: randomUUID(),
          purpose,
          name: 'x',
          mimeType: 'text/plain',
          size: temp.size,
          uploaderId: UPLOADER,
        }),
      );
    } catch (error) {
      // The route's answer: the temporary file goes, renamed bytes are the sweep's (§4.5 step 2).
      // The one failure expected here: the sweep removed a temporary file older than an hour
      // before the rename. Anything else fails the property.
      if (!(error instanceof Error) || error.message !== 'No such temporary upload.') throw error;
      await blobs.discard(temp.tempPath);
    }
  }

  async function run(operation: Operation) {
    // Rows are picked when the operation starts moving, not when it is queued.
    await db.step(`start ${operation.op}`);
    switch (operation.op) {
      case 'upload':
        return upload(operation.content, operation.purpose);
      case 'save': {
        // §4.3's save: the claims and the copy sources locked first, then every key at once.
        const claim = pick(operation.claim, (r) => r.purpose === 'inline' && r.issueId === null);
        const sources = new Set<string>();
        for (const n of operation.sources) {
          const source = pick(n);
          if (source !== undefined && source.id !== claim?.id) sources.add(source.id);
        }
        if (claim === undefined && sources.size === 0) return;
        await db
          .transaction(async (tx) => {
            const { unusable } = await insertCopies(
              tx,
              blobs,
              {
                claims:
                  claim === undefined
                    ? []
                    : [{ id: claim.id, issueId: operation.issue, uploaderId: UPLOADER }],
                copies: [...sources].map((sourceId) => ({
                  sourceId,
                  file: {
                    id: randomUUID(),
                    purpose: 'inline' as const,
                    name: 'x',
                    mimeType: 'text/plain',
                    size: 1,
                    uploaderId: UPLOADER,
                    issueId: operation.issue,
                  },
                })),
              },
              silent,
            );
            if (unusable.length > 0) throw new Refused();
          })
          .catch((error: unknown) => {
            if (!(error instanceof Refused)) throw error;
          });
        return;
      }
      case 'preview': {
        const source = pick(operation.pick, (row) => row.purpose === 'attachment');
        if (source === undefined) return;
        const temp = await blobs.putStream(body(operation.content));
        let inserted = false;
        try {
          inserted = await db.transaction((tx) =>
            insertPreview(tx, blobs, temp, {
              id: randomUUID(),
              purpose: 'preview',
              name: 'preview.webp',
              mimeType: 'image/webp',
              size: temp.size,
              uploaderId: UPLOADER,
              previewOf: source.id,
            }),
          );
        } finally {
          if (!inserted) await blobs.discard(temp.tempPath);
        }
        return;
      }
      case 'claim': {
        const row = pick(operation.pick);
        if (row !== undefined) {
          await db.modelTransaction((tx) => tx.claim(row.id, operation.issue));
        }
        return;
      }
      case 'detach': {
        const row = pick(operation.pick);
        if (row !== undefined) await db.modelTransaction((tx) => tx.detach(row.id));
        return;
      }
      case 'name': {
        const row = pick(operation.pick, (r) => r.purpose === 'avatar');
        if (row === undefined) return;
        // Naming a file deleted meanwhile fails its foreign key, like `user.updateProfile`.
        await db.modelTransaction((tx) => tx.name(row.id)).catch(() => undefined);
        return;
      }
      case 'unname': {
        const row = pick(operation.pick, (r) => r.purpose === 'avatar');
        if (row !== undefined) await db.modelTransaction((tx) => tx.unname(row.id));
        return;
      }
      case 'purge':
        await db.modelTransaction(async (tx) =>
          deleteFiles(tx, await tx.filesOfIssue(operation.issue)),
        );
        return;
      case 'cleanup':
        await cleanupFiles({ db, blobs, log: silent, now: () => new Date(db.clock), batch: 2 });
        return;
      case 'drain':
        await drainBlobRelease(db, blobs, silent, 2);
        return;
      case 'sweep':
        await sweep(db, blobs, new Date(db.clock), silent, 2);
        return;
      case 'advance':
        await db.step('advance');
        db.clock += operation.hours * MODEL_HOUR;
        return;
    }
  }

  return { db, blobs, violations, check, run };
}

describe('the byte protocol (SPEC-014 §4.5, AC-14 model half)', () => {
  it('never lets a row name missing bytes, and leaves no bytes without a row after a final drain and sweep', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        // Run one after another first, so the concurrent part finds rows, shared keys,
        // claims, previews, avatars and time to clean up.
        fc.array(OPERATION, { minLength: 4, maxLength: 16 }),
        fc.array(OPERATION, { minLength: 2, maxLength: 12 }),
        async (s, setup, operations) => {
          const w = world();
          for (const operation of setup) await w.run(operation);
          w.check();
          w.db.step = (label) => s.schedule(Promise.resolve(label)).then(() => undefined);
          const failures: unknown[] = [];
          let finished = 0;
          for (const operation of operations) {
            void w.run(operation).then(
              () => finished++,
              (error: unknown) => failures.push(error),
            );
          }
          for (;;) {
            await settle();
            if (s.count() === 0) break;
            await s.waitNext(1);
            w.check();
          }
          await settle();
          // Every operation ended: none waits on a lock forever (no deadlock), none failed. A
          // copy finding no bytes (E18) would fail here as `FileBytesMissing`.
          expect(failures.filter((e) => e instanceof FileBytesMissing)).toEqual([]);
          expect(failures).toEqual([]);
          expect(finished).toBe(operations.length);
          expect(w.db.open).toBe(0);
          expect(w.violations).toEqual([]);

          // The final drain and sweep, unscheduled.
          w.db.step = () => Promise.resolve();
          await drainBlobRelease(w.db, w.blobs, silent);
          await sweep(w.db, w.blobs, new Date(w.db.clock + 2 * MODEL_HOUR), silent);
          w.check();
          expect(w.violations).toEqual([]);
          const named = new Set([...w.db.rows.values()].map((row) => row.storageKey));
          expect(new Set(w.blobs.keys())).toEqual(named);
          expect(w.blobs.temps()).toEqual([]);
          expect(w.db.released.size).toBe(0);
          // No preview outlives its source (E21).
          for (const row of w.db.rows.values()) {
            if (row.previewOf !== null) expect(w.db.rows.has(row.previewOf)).toBe(true);
          }
        },
      ),
      propertyParameters({ seed: 20261113, numRuns: 400 }),
    );
  });

  it('never unlinks bytes an upload, a copy or a preview is naming while a drain and a sweep run, and never deadlocks a save with a clean-up (§4.5 steps 1–5)', async () => {
    // The random mix above rarely lines a released key up with new rows on it; here every run
    // starts that way: `a`'s only row is cleaned up (its key waits in `blob_release`), and `b`'s
    // key is there too while its claimed attachment stays (as after deleting one of two rows
    // sharing a key). And `c` has an unclaimed inline upload a day old, which the clean-up
    // deletes, next to a claimed attachment on the same key: a save claiming the one and copying
    // the other goes row, row, key, where a save going row, key, row, key deadlocks with the
    // clean-up (row, key). Then they race.
    const RACER = fc.constantFrom<Operation>(
      { op: 'upload', content: 'a', purpose: 'attachment' },
      { op: 'upload', content: 'c', purpose: 'inline' },
      { op: 'save', claim: 0, sources: [0, 2], issue: 'issue-1' },
      { op: 'save', claim: 0, sources: [2, 2], issue: 'issue-2' },
      { op: 'preview', pick: 0, content: 'a' },
      { op: 'preview', pick: 0, content: 'c' },
      { op: 'purge', issue: 'issue-1' },
      { op: 'drain' },
      { op: 'sweep' },
      { op: 'cleanup' },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(RACER, { minLength: 2, maxLength: 8 }),
        async (s, operations) => {
          const w = world();
          await w.run({ op: 'upload', content: 'a', purpose: 'attachment' });
          const [a] = [...w.db.rows.keys()];
          await w.run({ op: 'upload', content: 'b', purpose: 'attachment' });
          await w.run({ op: 'claim', pick: 1, issue: 'issue-1' });
          // `a` goes without a drain: its bytes stay, its key waits in `blob_release`.
          await w.db.transaction((tx) => deleteFiles(tx, [a ?? '']));
          for (const row of w.db.rows.values()) w.db.released.add(row.storageKey);
          await w.run({ op: 'upload', content: 'c', purpose: 'inline' });
          await w.run({ op: 'upload', content: 'c', purpose: 'attachment' });
          await w.run({ op: 'claim', pick: 2, issue: 'issue-2' });
          await w.run({ op: 'advance', hours: 25 });
          const rows = [...w.db.rows.values()];
          expect(rows.map((row) => [row.purpose, row.issueId])).toEqual([
            ['attachment', 'issue-1'],
            ['inline', null],
            ['attachment', 'issue-2'],
          ]);
          expect(w.db.released.size).toBe(2);
          expect(w.blobs.keys()).toHaveLength(3);
          w.db.step = (label) => s.schedule(Promise.resolve(label)).then(() => undefined);
          const failures: unknown[] = [];
          let finished = 0;
          for (const operation of operations) {
            void w.run(operation).then(
              () => finished++,
              (error: unknown) => failures.push(error),
            );
          }
          for (;;) {
            await settle();
            if (s.count() === 0) break;
            await s.waitNext(1);
            w.check();
          }
          expect(failures).toEqual([]);
          expect(finished).toBe(operations.length);
          expect(w.db.open).toBe(0);
          expect(w.violations).toEqual([]);
        },
      ),
      propertyParameters({ seed: 20261113, numRuns: 300 }),
    );
  });

  it('keeps one copy of bytes for two rows, and unlinks it only after the last row goes (E2)', async () => {
    const w = world();
    await w.run({ op: 'upload', content: 'a', purpose: 'attachment' });
    await w.run({ op: 'upload', content: 'a', purpose: 'attachment' });
    expect(w.db.rows.size).toBe(2);
    expect(w.blobs.keys()).toHaveLength(1);
    const [first, second] = [...w.db.rows.keys()];
    await w.db.transaction((tx) => deleteFiles(tx, [first ?? '']));
    await drainBlobRelease(w.db, w.blobs, silent);
    expect(w.blobs.keys()).toHaveLength(1);
    await w.db.transaction((tx) => deleteFiles(tx, [second ?? '']));
    expect(w.blobs.keys()).toHaveLength(1); // a delete never unlinks: the drain does
    await drainBlobRelease(w.db, w.blobs, silent);
    expect(w.blobs.keys()).toEqual([]);
    expect(w.db.released.size).toBe(0);
  });

  it('makes a copy racing the delete of its key’s last row wait, then find the bytes (E18)', async () => {
    const w = world();
    // Two rows on one key: the purge deletes the first, the copy's source is the second, which
    // the purge never locks. Only the key lock makes the copy wait.
    await w.run({ op: 'upload', content: 'a', purpose: 'attachment' });
    await w.run({ op: 'upload', content: 'a', purpose: 'attachment' });
    const [deleted, kept] = [...w.db.rows.values()];
    if (deleted === undefined || kept === undefined) throw new Error('no uploads');
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const purge = w.db.transaction(async (tx) => {
      await deleteFiles(tx, [deleted.id]);
      await held; // the transaction stays open, holding the key lock
    });
    await settle();
    let copied = false;
    const file = {
      id: randomUUID(),
      purpose: 'inline' as const,
      name: 'x',
      mimeType: 'text/plain',
      size: 1,
      uploaderId: UPLOADER,
      issueId: 'issue-1',
    };
    const copy = w.db
      .transaction((tx) =>
        insertCopies(tx, w.blobs, { claims: [], copies: [{ sourceId: kept.id, file }] }, silent),
      )
      .then(() => (copied = true));
    await settle();
    expect(copied).toBe(false); // waiting on the key lock
    release();
    await purge;
    await copy;
    expect(w.db.rows.get(file.id)?.storageKey).toBe(kept.storageKey);
    await drainBlobRelease(w.db, w.blobs, silent);
    expect(w.blobs.keys()).toEqual([kept.storageKey]);
  });
});
