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

function request(
  fake: FakeHub,
  parents: ContentParent[],
  schemaHash = SCHEMA_HASH,
  userId = USER_ID,
) {
  return raw(fake, encodeContentQuery({ parents, userId, schemaHash }));
}

function raw(fake: FakeHub, query: string) {
  return fake.fetch(`http://surface.test${CONTENT_PATH}?${query}`, {});
}

async function errorCode(response: Response): Promise<[number, unknown]> {
  const body: unknown = await response.json();
  const error: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return [response.status, code];
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

  it('lists the found parents in request order, as the server since PLAN-011 S6', async () => {
    const fake = hub();
    const parents = [item(2), item(1)];
    const answer = await frames(await request(fake, parents), parents);
    expect(answer[0]).toMatchObject({ parents: [item(2), item(1)], rows: 3 });
    expect(answer.flatMap((f) => (f.t === 'row' ? [f.d.id] : []))).toEqual([
      id(11),
      id(12),
      id(21),
    ]);
  });

  it('cuts a multi-parent answer to its budget, the first visible parent always taken (D16)', async () => {
    const fake = hub();
    fake.contentBudget = 1;
    const parents = [item(2), item(1)];
    const answer = await frames(await request(fake, parents), parents);
    expect(answer[0]).toMatchObject({ parents: [item(2)], rows: 1 });
    // A single-parent request is never cut.
    fake.contentBudget = 0;
    const alone = await frames(await request(fake, [item(1)]), [item(1)]);
    expect(alone[0]).toMatchObject({ parents: [item(1)], rows: 2 });
  });

  it('refuses a bad query, a missing userId and another user before the first frame', async () => {
    const fake = hub();
    const userless = new URLSearchParams(
      encodeContentQuery({
        parents: [item(1)],
        userId: USER_ID,
        schemaHash: SCHEMA_HASH,
      }),
    );
    userless.delete('userId');
    expect(await errorCode(await raw(fake, userless.toString()))).toEqual([426, 'CLIENT_OUTDATED']);
    expect(await errorCode(await request(fake, []))).toEqual([400, 'INVALID_INPUT']);
    expect(await errorCode(await request(fake, [item(1)], SCHEMA_HASH, id(99)))).toEqual([
      401,
      'UNAUTHENTICATED',
    ]);
    expect(fake.users.content).toEqual([id(99)]);
    expect(fake.contentRequests).toEqual([]);
  });

  it('sends the server’s code with each injected error status', async () => {
    const fake = hub();
    const codes: [number, unknown][] = [];
    for (const status of [401, 403, 426, 503]) {
      fake.contentStatus = status;
      codes.push(await errorCode(await request(fake, [item(1)])));
    }
    expect(codes).toEqual([
      [401, 'UNAUTHENTICATED'],
      [403, 'FORBIDDEN'],
      [426, 'CLIENT_OUTDATED'],
      [503, 'UNAVAILABLE'],
    ]);
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
