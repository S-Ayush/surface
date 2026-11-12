import { ProtocolError } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import type { BootstrapProgress } from '../src/bootstrap.js';
import { BootstrapFailedError, ClientOutdatedError, bootstrap } from '../src/bootstrap.js';
import { Persistence } from '../src/persistence.js';
import { ObjectPool } from '../src/pool.js';
import { MemoryStorage } from '../src/storage/memory.js';
import type { SyncStorage } from '../src/storage/types.js';
import { DebugItem, TEST_MODELS, debugRow, id, USER_ID } from './support/models.js';
import {
  TEST_SCHEMA_HASH,
  bootstrapFrames,
  fakeFetch,
  gatedResponse,
  ndjsonResponse,
} from './support/server.js';

const items = (...ns: number[]) => ns.map((n) => ({ model: 'DebugItem', row: debugRow(n) }));
const names = TEST_MODELS.map((m) => m.name);

function setup(storage: SyncStorage = new MemoryStorage(names)) {
  const pool = new ObjectPool(TEST_MODELS);
  const persistence = new Persistence(storage, undefined);
  return { pool, persistence, storage };
}

const run = (
  context: ReturnType<typeof setup>,
  fetch: ReturnType<typeof fakeFetch>,
  extra: { chunkSize?: number; onProgress?: (p: BootstrapProgress) => void } = {},
) =>
  bootstrap({
    fetch,
    baseUrl: 'http://surface.test',
    userId: USER_ID,
    schemaHash: TEST_SCHEMA_HASH,
    ...context,
    ...extra,
  });

describe('bootstrap', () => {
  it('streams rows into the pool and storage, and reports progress per chunk', async () => {
    const context = setup();
    const fetch = fakeFetch(() => ndjsonResponse(bootstrapFrames(items(1, 2, 3, 4, 5)), 7));
    const progress: BootstrapProgress[] = [];
    const result = await run(context, fetch, { chunkSize: 2, onProgress: (p) => progress.push(p) });

    // SPEC-002 E14: the server checks the user against the session.
    expect(fetch.urls).toEqual([`http://surface.test/sync/bootstrap?userId=${USER_ID}`]);
    expect(result).toMatchObject({ lastSyncId: 100, groups: ['workspace'], rows: 5 });
    expect(context.pool.count(DebugItem)).toBe(5);
    expect(context.pool.get(DebugItem, id(3))?.title).toBe('Item 3');
    expect(progress.map((p) => p.loaded)).toEqual([0, 2, 4, 5]);
    expect(progress.every((p) => p.total === 5)).toBe(true);
    const meta = await context.storage.readMeta();
    expect(meta).toMatchObject({ state: 'ready', lastSyncId: 100, schemaHash: TEST_SCHEMA_HASH });
    expect((await context.storage.readRows('DebugItem', undefined, 10)).rows).toHaveLength(5);
  });

  it('drops columns the model does not declare', async () => {
    const context = setup();
    const rows = [{ model: 'DebugItem', row: { ...debugRow(1), sync_groups: ['workspace'] } }];
    await run(
      context,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(rows))),
    );
    // Fields are prototype getters, so inspect the serialised row (toJSON).
    const serialised: unknown = JSON.parse(JSON.stringify(context.pool.get(DebugItem, id(1))));
    expect(Object.keys(serialised ?? {}).sort()).toEqual([
      'archivedAt',
      'counter',
      'groups',
      'id',
      'title',
    ]);
  });

  it('asks for a reload when the server runs another schema (E7)', async () => {
    const context = setup();
    const frames = bootstrapFrames(items(1), { schemaHash: 'f'.repeat(64) });
    await expect(
      run(
        context,
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toBeInstanceOf(ClientOutdatedError);
    expect(context.pool.count(DebugItem)).toBe(0);
    expect(await context.storage.readMeta()).toBeUndefined();
  });

  it('fails on a stream that stops before the end frame, leaving the replica unfinished', async () => {
    const context = setup();
    const frames = bootstrapFrames(items(1, 2)).slice(0, -1);
    await expect(
      run(
        context,
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toBeInstanceOf(BootstrapFailedError);
    expect((await context.storage.readMeta())?.state).toBe('bootstrapping');
  });

  it('fails when fewer rows arrive than announced', async () => {
    const context = setup();
    const frames = bootstrapFrames(items(1, 2));
    frames.splice(1, 1);
    await expect(
      run(
        context,
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toThrow(
      'Invalid bootstrap stream: 1 rows received, meta announced 2, end announced 2',
    );
  });

  it('fails when the meta frame announced a different count than arrived', async () => {
    const frames = bootstrapFrames(items(1, 2));
    const [meta] = frames;
    if (meta?.t !== 'meta') throw new Error('expected a meta frame');
    frames[0] = { ...meta, rows: 3 };
    await expect(
      run(
        setup(),
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toThrow(
      'Invalid bootstrap stream: 2 rows received, meta announced 3, end announced 2',
    );
  });

  it.each([
    ['a row before meta', [{ t: 'row', m: 'DebugItem', d: debugRow(1) }]],
    ['two meta frames', [...bootstrapFrames([]).slice(0, 1), ...bootstrapFrames([])]],
    ['data after end', [...bootstrapFrames([]), { t: 'end', rows: 0 }]],
    ['a row of an unknown model', bootstrapFrames([{ model: 'Ghost', row: debugRow(1) }])],
  ])('rejects %s', async (_case, frames) => {
    await expect(
      run(
        setup(),
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rejects a row that does not match its model, without echoing its data', async () => {
    const rows = [{ model: 'DebugItem', row: { ...debugRow(1), title: 42, secret: 'hunter2' } }];
    const attempt = run(
      setup(),
      fakeFetch(() => ndjsonResponse(bootstrapFrames(rows))),
    );
    await expect(attempt).rejects.toThrow(/^Invalid DebugItem row\.title: /);
    await expect(
      run(
        setup(),
        fakeFetch(() => ndjsonResponse(bootstrapFrames(rows))),
      ),
    ).rejects.not.toThrow(/hunter2|42/);
  });

  // A server of a later protocol (sync-protocol §4.1): 426 CLIENT_OUTDATED before any frame.
  it('asks for a reload when the server answers that this client is outdated', async () => {
    const context = setup();
    const body = {
      ok: false,
      error: { code: 'CLIENT_OUTDATED', message: 'x', correlationId: 'c' },
    };
    await expect(
      run(
        context,
        fakeFetch(() => new Response(JSON.stringify(body), { status: 426 })),
      ),
    ).rejects.toBeInstanceOf(ClientOutdatedError);
    expect(await context.storage.readMeta()).toBeUndefined();
  });

  it('reports the HTTP status of a failed request', async () => {
    const attempt = run(
      setup(),
      fakeFetch(() => new Response('{}', { status: 401 })),
    );
    await expect(attempt).rejects.toMatchObject({ name: 'BootstrapFailedError', status: 401 });
  });

  it('replaces the pool on re-bootstrap: rows gone from the server disappear, overlays stay', async () => {
    const context = setup();
    await run(
      context,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(items(1, 2, 3)))),
    );
    const kept = context.pool.get(DebugItem, id(1));
    context.pool.setOverlay('DebugItem', id(9), { row: debugRow(9), archived: false });

    const changed = [{ model: 'DebugItem', row: debugRow(1, { title: 'Renamed' }) }, ...items(4)];
    await run(
      context,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(changed, { lastSyncId: 200 }))),
    );

    expect(
      context.pool
        .all(DebugItem)
        .map((item) => item.id)
        .sort(),
    ).toEqual([id(1), id(4), id(9)]);
    expect(context.pool.get(DebugItem, id(1))).toBe(kept);
    expect(kept?.title).toBe('Renamed');
  });

  it('keeps going in memory when storage fails mid-way', async () => {
    const storage = new MemoryStorage(names);
    const context = setup(storage);
    let writes = 0;
    const original = storage.writeBootstrapRows.bind(storage);
    storage.writeBootstrapRows = (generation, rows) => {
      writes += 1;
      return writes === 2
        ? Promise.reject(new Error('QuotaExceededError'))
        : original(generation, rows);
    };
    const result = await run(
      context,
      fakeFetch(() => ndjsonResponse(bootstrapFrames(items(1, 2, 3, 4)))),
      {
        chunkSize: 1,
      },
    );
    expect(context.pool.count(DebugItem)).toBe(4);
    expect(context.persistence.warning).toBe('QuotaExceededError');
    expect(result.generation).toBeUndefined();
    // The unfinished replica is never marked ready, so a reload bootstraps again.
    expect((await storage.readMeta())?.state).toBe('bootstrapping');
  });

  it('cancels the download when the stream turns out to be invalid', async () => {
    const [meta] = bootstrapFrames(items(1));
    const gated = gatedResponse([meta, { t: 'row', m: 'Nope', d: { id: id(1) } }], []);
    await expect(
      run(
        setup(),
        fakeFetch(() => gated.response),
      ),
    ).rejects.toThrow(/unknown model/);
    expect(gated.state.cancelled).toBe(true);
    gated.release();
  });

  it('stops and cancels the download when aborted', async () => {
    const frames = bootstrapFrames(items(1, 2));
    const gated = gatedResponse(frames.slice(0, 1), frames.slice(1));
    const controller = new AbortController();
    const running = bootstrap({
      fetch: fakeFetch(() => gated.response),
      baseUrl: '',
      userId: USER_ID,
      schemaHash: TEST_SCHEMA_HASH,
      ...setup(),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(gated.state.cancelled).toBe(true);
    gated.release();
  });

  it('says how to recover when the stream stops early', async () => {
    const frames = bootstrapFrames(items(1, 2)).slice(0, -1);
    await expect(
      run(
        setup(),
        fakeFetch(() => ndjsonResponse(frames)),
      ),
    ).rejects.toThrow(
      /stopped arriving before it was complete\. Check your connection and reload the page\./,
    );
  });
});
