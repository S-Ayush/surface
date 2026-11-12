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

  it('reads a file its uploader, or anyone once in use, may see', async () => {
    const { client, texts } = fakeClient();
    await PG_FILE_STORE.readable(client, 'f', 'u');
    expect(texts[0]).toContain('"storage_key"');
    expect(texts[0]).toContain('"uploader_id" = $');
    expect(texts[0]).toContain('"avatar_file_id" = "files"."id"');
    expect(texts[0]).toContain('"logo_file_id" = "files"."id"');
  });
});
