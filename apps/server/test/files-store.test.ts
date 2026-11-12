// PLAN-001 S6: the files store's SQL, read from a fake client (Postgres tests are held, plans
// README §6). The columns are snake_case, as the migration made them (found in the hand check).
import { describe, expect, it } from 'vitest';
import { PG_FILE_STORE } from '../src/files/store.js';

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
  it('inserts into the migration’s snake_case columns', async () => {
    const { client, texts } = fakeClient();
    await PG_FILE_STORE.insert(client, {
      id: '01930000-0000-7000-8000-0000000000f1',
      storageKey: `sha256/aa/aa/${'a'.repeat(64)}`,
      purpose: 'avatar',
      name: 'avatar.webp',
      mimeType: 'image/webp',
      size: 10,
      uploaderId: '01930000-0000-7000-8000-00000000ada1',
    });
    expect(texts[0]).toContain(
      '"storage_key", "purpose", "name", "mime_type", "size", "uploader_id"',
    );
  });

  it('inserts the issue-file columns too (SPEC-014 §4.2)', async () => {
    const { client, texts } = fakeClient();
    await PG_FILE_STORE.insert(client, {
      id: '01930000-0000-7000-8000-0000000000f2',
      storageKey: `sha256/bb/bb/${'b'.repeat(64)}`,
      purpose: 'preview',
      name: 'preview.webp',
      mimeType: 'image/webp',
      size: 3_000_000_000,
      uploaderId: '01930000-0000-7000-8000-00000000ada1',
      issueId: null,
      width: 800,
      height: 600,
      previewOf: '01930000-0000-7000-8000-0000000000f1',
    });
    expect(texts[0]).toContain('"issue_id"');
    expect(texts[0]).toContain('"width", "height", "preview_of"');
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
    });
    expect(texts[0]).toContain('JOIN files s ON s.id = coalesce(f.preview_of, f.id)');
  });

  it('answers undefined for a file the reader can’t see', async () => {
    const { client } = fakeClient([]);
    await expect(
      PG_FILE_STORE.visibleFile(client, 'f', { userId: 'u', groups: [], keyTeamIds: null }),
    ).resolves.toBeUndefined();
  });
});
