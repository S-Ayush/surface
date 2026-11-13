// PLAN-001 S6: the files store's SQL, read from a fake client (Postgres tests are held, plans
// README §6). The columns are snake_case, as the migration made them (found in the hand check).
import { describe, expect, it } from 'vitest';
import { fileStorageStats, PG_FILE_STORE } from '../src/files/store.js';

function fakeClient(rows: object[] = []) {
  const texts: string[] = [];
  const client = {
    query: (config: string | { text: string }) => {
      texts.push(typeof config === 'string' ? config : config.text);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [], command: 'SELECT' });
    },
  };
  return { client: client as never, texts };
}

describe('the files store (ADR-0014)', () => {
  // Every insert goes through the byte protocol (PLAN-014 S3): the key lock, the rename, the row.
  const commits: string[] = [];
  const blobs = {
    commit: (tempPath: string, key: string) => {
      commits.push(`${tempPath} -> ${key}`);
      return Promise.resolve();
    },
  };

  it('inserts into the migration’s snake_case columns, after the key lock and the rename', async () => {
    const { client, texts } = fakeClient();
    const key = `sha256/aa/aa/${'a'.repeat(64)}`;
    await PG_FILE_STORE.insertUpload(
      client,
      blobs,
      { tempPath: 't.tmp', key },
      {
        id: '01930000-0000-7000-8000-0000000000f1',
        purpose: 'avatar',
        name: 'avatar.webp',
        mimeType: 'image/webp',
        size: 10,
        uploaderId: '01930000-0000-7000-8000-00000000ada1',
      },
    );
    expect(texts[0]).toContain('pg_advisory_xact_lock');
    expect(commits).toContain(`t.tmp -> ${key}`);
    expect(texts[1]).toContain(
      '"storage_key", "purpose", "name", "mime_type", "size", "uploader_id"',
    );
  });

  it('inserts the issue-file columns too (SPEC-014 §4.2)', async () => {
    const { client, texts } = fakeClient();
    await PG_FILE_STORE.insertUpload(
      client,
      blobs,
      { tempPath: 'u.tmp', key: `sha256/bb/bb/${'b'.repeat(64)}` },
      {
        id: '01930000-0000-7000-8000-0000000000f2',
        purpose: 'preview',
        name: 'preview.webp',
        mimeType: 'image/webp',
        size: 3_000_000_000,
        uploaderId: '01930000-0000-7000-8000-00000000ada1',
        issueId: null,
        width: 800,
        height: 600,
        previewOf: '01930000-0000-7000-8000-0000000000f1',
      },
    );
    expect(texts[1]).toContain('"issue_id"');
    expect(texts[1]).toContain('"width", "height", "preview_of"');
  });

  it('reads a file through the one visibility statement, as numbers', async () => {
    const { client, texts } = fakeClient([
      {
        id: 'f',
        purpose: 'avatar',
        uploaderId: 'u',
        storageKey: 'k',
        mimeType: 'image/webp',
        size: '3000000000',
        name: 'avatar.webp',
      },
    ]);
    const file = await PG_FILE_STORE.visibleFile(client, 'f', {
      userId: 'u',
      groups: ['workspace'],
      keyTeamIds: null,
    });
    // `bigint` arrives as a string from node-postgres; files over 2 GB still read as numbers.
    expect(file).toEqual({
      id: 'f',
      purpose: 'avatar',
      uploaderId: 'u',
      storageKey: 'k',
      mimeType: 'image/webp',
      size: 3_000_000_000,
      name: 'avatar.webp',
    });
    expect(texts[0]).toContain('JOIN files s ON s.id = coalesce(f.preview_of, f.id)');
    expect(texts[0]).toContain('f.name');
  });

  it('answers undefined for a file the reader can’t see', async () => {
    const { client } = fakeClient([]);
    await expect(
      PG_FILE_STORE.visibleFile(client, 'f', { userId: 'u', groups: [], keyTeamIds: null }),
    ).resolves.toBeUndefined();
  });

  it('reserves an upload under the uploader’s transaction lock, counting after it (review M2)', async () => {
    const within = fakeClient([{ files: '99', bytes: '0' }]);
    await expect(PG_FILE_STORE.reserveUpload(within.client, 'u', 10)).resolves.toBe(true);
    // The lock first, so a parallel upload's insert is counted, never missed.
    expect(within.texts[0]).toContain('pg_advisory_xact_lock');
    expect(within.texts[1]).toContain('count(*)');
    const full = fakeClient([{ files: '100', bytes: '0' }]);
    await expect(PG_FILE_STORE.reserveUpload(full.client, 'u', 10)).resolves.toBe(false);
  });

  it('counts a user’s unclaimed attachment and inline uploads for the caps (SPEC-014 §4.6)', async () => {
    const { client, texts } = fakeClient([{ files: '3', bytes: '3000000000' }]);
    await expect(PG_FILE_STORE.unclaimedUsage(client, 'u')).resolves.toEqual({
      files: 3,
      bytes: 3_000_000_000,
    });
    // The shape of the partial index `files_unclaimed_uploader_idx`, so it serves the count.
    expect(texts[0]?.replace(/\s+/g, ' ')).toContain(
      "WHERE uploader_id = $1 AND issue_id IS NULL AND purpose IN ('attachment', 'inline')",
    );
  });

  it('reports stored bytes once per key and the blob_release backlog, as numbers (SPEC-014 §10)', async () => {
    const { client, texts } = fakeClient([{ stored: '3000000000', backlog: '2' }]);
    await expect(fileStorageStats(client)).resolves.toEqual({
      storedBytes: 3_000_000_000,
      releaseBacklog: 2,
    });
    expect(texts[0]).toContain('DISTINCT ON (storage_key)');
    expect(texts[0]).toContain('FROM blob_release');
  });
});
