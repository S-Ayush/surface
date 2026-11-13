// PLAN-014 S3: the byte protocol's SQL (`pgFileTx`), read from a fake client, and the copy's
// missing-bytes path (SPEC-014 §4.5 step 3). `files-bytes-pg.int.test.ts` runs it on Postgres.
import { describe, expect, it } from 'vitest';
import { LOCK_CLASSES } from '../src/db/locks.js';
import { memoryBlobStore } from '../src/files/blob-store.js';
import {
  cleanupCandidatesQuery,
  cleanupReason,
  FileBytesMissing,
  insertCopy,
  pgFileTx,
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
  it('locks each key once, in ascending order, on the fileBytes class', async () => {
    const { client, calls } = fakeClient();
    await pgFileTx(client).lockKeys([KEY_B, KEY_A, KEY_B]);
    expect(calls).toEqual([
      {
        text: 'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
        values: [LOCK_CLASSES.fileBytes, KEY_A],
      },
      {
        text: 'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
        values: [LOCK_CLASSES.fileBytes, KEY_B],
      },
    ]);
    expect(new Set(Object.values(LOCK_CLASSES)).size).toBe(Object.values(LOCK_CLASSES).length);
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
    expect(cleanupReason({ purpose: 'inline', issueId: null, detachedAt: null })).toBe('unclaimed');
    expect(cleanupReason({ purpose: 'attachment', issueId: 'i', detachedAt: new Date() })).toBe(
      'detached',
    );
    expect(cleanupReason({ purpose: 'logo', issueId: null, detachedAt: null })).toBe('unused');
  });
});

describe('insertCopy (SPEC-014 §4.5 step 3)', () => {
  it('refuses to insert a row for missing bytes, logging the file id only', async () => {
    const { client, calls } = fakeClient();
    const errors: { object: object; message: string }[] = [];
    const log = {
      error: (object: object, message: string) => void errors.push({ object, message }),
    };
    const file = {
      id: '01930000-0000-7000-8000-0000000000f3',
      storageKey: KEY_A,
      purpose: 'inline' as const,
      name: 'secret plans.pdf',
      mimeType: 'application/pdf',
      size: 3,
      uploaderId: '01930000-0000-7000-8000-00000000ada1',
      issueId: '01930000-0000-7000-8000-0000000000e1',
    };
    const error = await insertCopy(pgFileTx(client), memoryBlobStore(), file, log).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FileBytesMissing);
    expect(String(error)).not.toContain(KEY_A);
    expect(errors).toEqual([{ object: { fileId: file.id }, message: 'file bytes missing' }]);
    // The key lock, then nothing: no insert.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('pg_advisory_xact_lock');
  });

  it('inserts the row once the bytes are found under the lock', async () => {
    const blobs = memoryBlobStore();
    const key = await blobs.put(Buffer.from('abc'));
    const { client, calls } = fakeClient();
    await insertCopy(
      pgFileTx(client),
      blobs,
      {
        id: '01930000-0000-7000-8000-0000000000f4',
        storageKey: key,
        purpose: 'inline',
        name: 'x',
        mimeType: 'text/plain',
        size: 3,
        uploaderId: '01930000-0000-7000-8000-00000000ada1',
      },
      { error: () => undefined },
    );
    expect(calls[1]?.text).toContain('insert into "files"');
  });
});
