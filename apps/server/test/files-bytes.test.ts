// PLAN-014 S3: the byte protocol's SQL (`pgFileTx`), read from a fake client, and a saved
// document's claims and copies (`insertCopies`, SPEC-014 §4.3, §4.5 steps 1 and 3). `files-bytes-pg.int.test.ts` runs it on Postgres.
import { describe, expect, it } from 'vitest';
import { LOCK_CLASSES } from '../src/db/locks.js';
import { memoryBlobStore } from '../src/files/blob-store.js';
import {
  cleanupCandidatesQuery,
  cleanupReason,
  FileBytesMissing,
  insertCopies,
  LOCK_KEYS_SQL,
  pgFileTx,
  type FileTx,
  type InlineCopy,
} from '../src/files/bytes.js';
import { PgDialect } from 'drizzle-orm/pg-core';

function fakeClient(rows: object[] = [], fail?: (text: string) => Error | undefined) {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: (config: string | { text: string }, values: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      calls.push({ text, values });
      const error = fail?.(text);
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [], command: 'SELECT' });
    },
  };
  return { client: client as never, calls };
}

const KEY_A = `sha256/aa/aa/${'a'.repeat(64)}`;
const KEY_B = `sha256/bb/bb/${'b'.repeat(64)}`;

describe('pgFileTx (SPEC-014 §4.5)', () => {
  it('locks every key in one statement, each once, in hash order, on the fileBytes class', async () => {
    const { client, calls } = fakeClient();
    await pgFileTx(client).lockKeys([KEY_B, KEY_A, KEY_B]);
    expect(calls).toEqual([
      { text: LOCK_KEYS_SQL, values: [LOCK_CLASSES.fileBytes, [KEY_B, KEY_A]] },
    ]);
    // Ordered by the hash the lock is taken on: colliding keys are one lock, taken once.
    expect(LOCK_KEYS_SQL).toContain('SELECT DISTINCT hashtext(k) AS h');
    expect(LOCK_KEYS_SQL).toContain('ORDER BY h');
    expect(new Set(Object.values(LOCK_CLASSES)).size).toBe(Object.values(LOCK_CLASSES).length);
    // No key: no statement.
    const none = fakeClient();
    await pgFileTx(none.client).lockKeys([]);
    expect(none.calls).toEqual([]);
  });

  it('claims an inline upload in one conditional statement: unclaimed, the actor’s own, inline', async () => {
    const claimed = fakeClient([{ id: 'f1' }]);
    expect(await pgFileTx(claimed.client).claimInline('f1', 'i1', 'u1')).toBe(true);
    const text = claimed.calls[0]?.text.replace(/\s+/g, ' ');
    expect(text).toContain('UPDATE files SET issue_id = $1');
    expect(text).toContain(
      "WHERE id = $2 AND issue_id IS NULL AND uploader_id = $3 AND purpose = 'inline'",
    );
    expect(text).toContain('RETURNING id');
    expect(claimed.calls[0]?.values).toEqual(['i1', 'f1', 'u1']);
    expect(await pgFileTx(fakeClient([]).client).claimInline('f1', 'i1', 'u1')).toBe(false);
  });

  it('locks rows in id order, FOR UPDATE to delete and FOR SHARE to copy from', async () => {
    const update = fakeClient();
    await pgFileTx(update.client).lockFiles(['b', 'a'], 'update');
    expect(update.calls[0]?.text).toMatch(/ORDER BY id FOR UPDATE$/);
    // One array parameter, not a list Postgres would read as a record.
    expect(update.calls[0]?.values).toEqual([['b', 'a']]);
    const share = fakeClient();
    await pgFileTx(share.client).lockFiles(['a'], 'share');
    expect(share.calls[0]?.text).toMatch(/ORDER BY id FOR SHARE$/);
    const previews = fakeClient();
    await pgFileTx(previews.client).lockPreviews(['a']);
    expect(previews.calls[0]?.text).toContain('WHERE preview_of = ANY');
    expect(previews.calls[0]?.text).toMatch(/FOR UPDATE$/);
    // Nothing to lock: no statement.
    const none = fakeClient();
    await pgFileTx(none.client).lockFiles([], 'update');
    await pgFileTx(none.client).deleteFiles([]);
    await pgFileTx(none.client).releaseKeys([]);
    expect(none.calls).toEqual([]);
  });

  it('records released keys once, and forgets a key only if it is still there', async () => {
    const { client, calls } = fakeClient();
    await pgFileTx(client).releaseKeys([KEY_A]);
    expect(calls[0]?.text).toContain('ON CONFLICT (storage_key) DO NOTHING');
    expect(await pgFileTx(fakeClient([{ storageKey: KEY_A }]).client).forgetKey(KEY_A)).toBe(true);
    expect(await pgFileTx(fakeClient([]).client).forgetKey(KEY_A)).toBe(false);
  });

  it('inserts into the migration’s snake_case columns', async () => {
    const { client, calls } = fakeClient();
    await pgFileTx(client).insertFile({
      id: '01930000-0000-7000-8000-0000000000f2',
      storageKey: KEY_A,
      purpose: 'preview',
      name: 'preview.webp',
      mimeType: 'image/webp',
      size: 3_000_000_000,
      uploaderId: '01930000-0000-7000-8000-00000000ada1',
      width: 800,
      height: 600,
      previewOf: '01930000-0000-7000-8000-0000000000f1',
    });
    expect(calls[0]?.text).toContain('"storage_key", "purpose", "name", "mime_type", "size"');
    expect(calls[0]?.text).toContain('"preview_of"');
  });

  it('rolls back to the savepoint when its work fails, and releases it when it doesn’t', async () => {
    const { client, calls } = fakeClient();
    const tx = pgFileTx(client);
    await tx.savepoint(() => Promise.resolve());
    await expect(tx.savepoint(() => Promise.reject(new Error('fk')))).rejects.toThrow('fk');
    expect(calls.map((call) => call.text)).toEqual([
      'SAVEPOINT file_bytes_1',
      'RELEASE SAVEPOINT file_bytes_1',
      'SAVEPOINT file_bytes_2',
      'ROLLBACK TO SAVEPOINT file_bytes_2',
    ]);
  });
});

describe('the clean-up statement (SPEC-014 §4.6)', () => {
  const text = (after?: string) =>
    new PgDialect()
      .sqlToQuery(cleanupCandidatesQuery(new Date(0), after, 100))
      .sql.replace(/\s+/g, ' ');

  it('takes rows SKIP LOCKED, in id order, after the last batch', () => {
    expect(text()).toContain('ORDER BY f.id LIMIT $');
    expect(text()).toMatch(/FOR UPDATE OF f SKIP LOCKED$/);
  });

  it('matches the three rules, leaving previews to their source', () => {
    const sql = text();
    expect(sql).toContain("f.purpose IN ('attachment', 'inline') AND f.issue_id IS NULL");
    expect(sql).toContain("f.purpose = 'attachment' AND f.detached_at <");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM workspace w WHERE w.logo_file_id = f.id)');
    expect(sql).not.toContain("'preview'");
  });

  it('names the reason a row matched', () => {
    expect(cleanupReason({ purpose: 'inline', issueId: null })).toBe('unclaimed');
    expect(cleanupReason({ purpose: 'attachment', issueId: null })).toBe('unclaimed');
    expect(cleanupReason({ purpose: 'attachment', issueId: 'i' })).toBe('detached');
    expect(cleanupReason({ purpose: 'logo', issueId: null })).toBe('unused');
    expect(cleanupReason({ purpose: 'avatar', issueId: null })).toBe('unused');
  });
});

const UPLOADER = '01930000-0000-7000-8000-00000000ada1';
const ISSUE = '01930000-0000-7000-8000-0000000000e1';

/** A `FileTx` that records the statements `insertCopies` makes, in order. */
function recordingTx(sources: ReadonlyMap<string, string>, claimable: ReadonlySet<string>) {
  const calls: string[] = [];
  const unexpected = () => Promise.reject(new Error('Not a statement insertCopies makes.'));
  const tx: FileTx = {
    claimInline: (id, issueId, uploaderId) => {
      calls.push(`claim ${id} ${issueId} ${uploaderId}`);
      return Promise.resolve(claimable.has(id));
    },
    lockFiles: (ids, mode) => {
      calls.push(`${mode} ${ids.join(',')}`);
      return Promise.resolve(
        ids.flatMap((id) => {
          const storageKey = sources.get(id);
          return storageKey === undefined ? [] : [{ id, storageKey }];
        }),
      );
    },
    lockKeys: (keys) => {
      calls.push(`keys ${keys.join(',')}`);
      return Promise.resolve();
    },
    insertFile: (file) => {
      calls.push(`insert ${file.id} ${file.storageKey}`);
      return Promise.resolve();
    },
    lockPreviews: unexpected,
    deleteFiles: unexpected,
    releaseKeys: unexpected,
    keyInUse: unexpected,
    forgetKey: unexpected,
    cleanupCandidates: unexpected,
    savepoint: unexpected,
  };
  return { tx, calls };
}

const copyOf = (sourceId: string, id: string): InlineCopy => ({
  sourceId,
  file: {
    id,
    purpose: 'inline',
    name: 'secret plans.pdf',
    mimeType: 'application/pdf',
    size: 3,
    uploaderId: UPLOADER,
    issueId: ISSUE,
  },
});

const quiet = { error: () => undefined };

describe('insertCopies (SPEC-014 §4.3, §4.5 steps 1 and 3)', () => {
  it('takes every claim and source lock in id order, then every key in one lock, then inserts', async () => {
    const blobs = memoryBlobStore();
    const keyA = await blobs.put(Buffer.from('a'));
    const keyB = await blobs.put(Buffer.from('b'));
    const { tx, calls } = recordingTx(
      new Map([
        ['s3', keyA],
        ['s1', keyB],
      ]),
      new Set(['s2']),
    );
    const result = await insertCopies(
      tx,
      blobs,
      {
        claims: [{ id: 's2', issueId: ISSUE, uploaderId: UPLOADER }],
        copies: [copyOf('s3', 'n1'), copyOf('s1', 'n2')],
      },
      quiet,
    );
    expect(result).toEqual({ unusable: [] });
    // Row, row, row, then the keys: never a key before a row lock, so no cycle with a clean-up.
    expect(calls).toEqual([
      'share s1',
      `claim s2 ${ISSUE} ${UPLOADER}`,
      'share s3',
      `keys ${keyB},${keyA}`,
      `insert n1 ${keyA}`,
      `insert n2 ${keyB}`,
    ]);
  });

  it('returns the files it can’t use, with no key lock and no insert, when a claim matches no row or a source is gone (E24)', async () => {
    const blobs = memoryBlobStore();
    const key = await blobs.put(Buffer.from('a'));
    const { tx, calls } = recordingTx(new Map([['s1', key]]), new Set());
    const result = await insertCopies(
      tx,
      blobs,
      {
        claims: [{ id: 'c1', issueId: ISSUE, uploaderId: UPLOADER }],
        copies: [copyOf('s1', 'n1'), copyOf('gone', 'n2')],
      },
      quiet,
    );
    expect(result).toEqual({ unusable: ['c1', 'gone'] });
    expect(calls).toEqual([`claim c1 ${ISSUE} ${UPLOADER}`, 'share gone', 'share s1']);
  });

  it('refuses to insert a row for missing bytes, logging the file id only', async () => {
    const errors: { object: object; message: string }[] = [];
    const log = {
      error: (object: object, message: string) => void errors.push({ object, message }),
    };
    const { tx, calls } = recordingTx(new Map([['s1', KEY_A]]), new Set());
    const error = await insertCopies(
      tx,
      memoryBlobStore(),
      { claims: [], copies: [copyOf('s1', 'n1')] },
      log,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileBytesMissing);
    expect(String(error)).not.toContain(KEY_A);
    expect(String(error)).not.toContain('secret plans');
    expect(errors).toEqual([{ object: { fileId: 'n1' }, message: 'file bytes missing' }]);
    // The locks, then nothing: no insert.
    expect(calls).toEqual(['share s1', `keys ${KEY_A}`]);
  });

  it('refuses a file both claimed and copied', async () => {
    const { tx, calls } = recordingTx(new Map(), new Set(['f1']));
    await expect(
      insertCopies(
        tx,
        memoryBlobStore(),
        {
          claims: [{ id: 'f1', issueId: ISSUE, uploaderId: UPLOADER }],
          copies: [copyOf('f1', 'n1')],
        },
        quiet,
      ),
    ).rejects.toThrow('either claimed or copied');
    expect(calls).toEqual([]);
  });
});
