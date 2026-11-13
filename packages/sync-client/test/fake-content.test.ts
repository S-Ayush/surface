// PLAN-011 S5a: the fake hub's `GET /sync/content` (SPEC-011 §5.2), which S5b's hydration tests
// run against. It must speak the real protocol, so its answers go through the protocol's reader.
import {
  ContentStreamReader,
  CONTENT_PATH,
  computeSchemaHash,
  encodeContentQuery,
  issueParent,
  NdjsonDecoder,
  type ContentFrame,
  type ContentParent,
} from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { FakeHub } from './support/hub.js';
import { CONTENT_TEST_MODELS, USER_ID, id } from './support/models.js';

const SCHEMA_HASH = computeSchemaHash(CONTENT_TEST_MODELS);

function hub(): FakeHub {
  const fake = new FakeHub();
  fake.schemaHash = SCHEMA_HASH;
  fake.upsert(1);
  fake.upsert(2);
  fake.upsertNote(11, 1);
  fake.upsertNote(12, 1);
  fake.upsertNote(21, 2);
  return fake;
}

function request(fake: FakeHub, parents: ContentParent[], schemaHash = SCHEMA_HASH) {
  const query = encodeContentQuery({ parents, userId: USER_ID, schemaHash });
  return fake.fetch(`http://surface.test${CONTENT_PATH}?${query}`, {});
}

async function frames(response: Response, parents: ContentParent[]): Promise<ContentFrame[]> {
  const decoder = new NdjsonDecoder();
  const reader = new ContentStreamReader(parents);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const out = [...decoder.push(bytes), ...decoder.end()].map((value) => reader.read(value));
  reader.finish();
  return out;
}

const item = (n: number) => issueParent(id(n));

describe('the fake hub’s /sync/content', () => {
  it('answers the visible parents’ content at the current head', async () => {
    const fake = hub();
    const parents = [item(1), item(3)];
    const answer = await frames(await request(fake, parents), parents);
    expect(answer[0]).toEqual({ t: 'meta', lastSyncId: fake.head, parents: [item(1)], rows: 2 });
    expect(answer.flatMap((f) => (f.t === 'row' ? [f.d.id] : []))).toEqual([id(11), id(12)]);
    expect(fake.contentRequests).toEqual([parents]);
  });

  it('leaves out a hidden parent like an unknown one', async () => {
    const fake = hub();
    fake.hiddenParents.add(id(2));
    const answer = await frames(await request(fake, [item(2)]), [item(2)]);
    expect(answer).toEqual([
      { t: 'meta', lastSyncId: fake.head, parents: [], rows: 0 },
      { t: 'end', rows: 0 },
    ]);
  });

  it('logs content writes as packets: I, U, a D with only the id, and a purge’s lone item D', () => {
    const fake = hub();
    const before = fake.log.length;
    fake.upsertNote(11, 1, 'Edited');
    fake.removeNote(12);
    fake.purge(2);
    expect(fake.log.slice(before).map((p) => `${p.a} ${p.a === 'G' ? '' : p.m}`)).toEqual([
      'U Note',
      'D Note',
      'D DebugItem',
    ]);
    expect(fake.notes.has(id(21))).toBe(false);
  });

  it('holds an answer at its snapshot while later packets commit', async () => {
    const fake = hub();
    fake.holdContent = true;
    const pending = request(fake, [item(1)]);
    const snapshotAt = fake.head;
    fake.upsertNote(13, 1);
    fake.releaseContent();
    const answer = await frames(await pending, [item(1)]);
    expect(answer[0]).toMatchObject({ lastSyncId: snapshotAt, rows: 2 });
    expect(fake.head).toBe(snapshotAt + 1);
  });

  it('injects faults: a network error, an error status, a cut-off stream, an outdated client', async () => {
    const fake = hub();
    fake.failContent = 1;
    await expect(request(fake, [item(1)])).rejects.toThrow('Failed to fetch');
    fake.contentStatus = 503;
    expect((await request(fake, [item(1)])).status).toBe(503);
    fake.contentStatus = 200;
    fake.truncateContent = true;
    await expect(frames(await request(fake, [item(1)]), [item(1)])).rejects.toThrow(
      'it ended before the end frame',
    );
    expect((await request(fake, [item(1)], 'b'.repeat(64))).status).toBe(426);
  });
});
