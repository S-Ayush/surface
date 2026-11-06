// PLAN-002 S2: the repo layer logs every write to `sync_log` (SPEC-002 §4.1–4.2,
// sync-protocol §3, §6), and the debug operations write only through it.
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKS } from '../src/db/locks.js';
import { syncRepo, type ChangeOrigin, type Flushed, type Repo } from '../src/sync/repo.js';
import { actors, executorHarness, testExecutor, type ExecutorHarness } from './executor.js';

let h: ExecutorHarness;
let who: ReturnType<typeof actors>;
beforeAll(async () => {
  h = await executorHarness();
  who = actors(h.teams);
});
afterAll(async () => {
  await h.close();
});

interface LogRow {
  sync_id: string;
  model: string;
  model_id: string;
  action: string;
  data: Record<string, unknown> | null;
  groups: string[];
  client_id: string | null;
  client_seq: string | null;
}

/** Runs `fn` against a repo in one committed transaction, then flushes like the executor. */
async function inRepo(
  fn: (repo: Repo) => Promise<unknown>,
  origin: ChangeOrigin = {},
): Promise<Flushed> {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await fn(repo);
    const flushed = await repo.flush(origin);
    await client.query('COMMIT');
    return flushed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lastSyncId(pool: pg.Pool = h.pool): Promise<number> {
  const { rows } = await pool.query<{ last: string }>(
    'SELECT last_sync_id AS last FROM sync_state',
  );
  return Number(rows[0]?.last);
}

async function logAfter(syncId: number): Promise<LogRow[]> {
  const { rows } = await h.pool.query<LogRow>(
    'SELECT * FROM sync_log WHERE sync_id > $1 ORDER BY sync_id',
    [syncId],
  );
  return rows;
}

describe('repo writes', () => {
  it('logs insert, update, archive, unarchive and purge as I, U, A, V and D, in order', async () => {
    const before = await lastSyncId();
    const id = randomUUID();
    const flushed = await inRepo(async (repo) => {
      await repo.insert('DebugItem', { id, title: 'One', syncGroups: ['workspace'] });
      await repo.update('DebugItem', id, { title: 'Two' });
      await repo.archive('DebugItem', id);
      await repo.unarchive('DebugItem', id);
      await repo.purge('DebugItem', id);
    });

    const log = await logAfter(before);
    expect(log.map((r) => [Number(r.sync_id), r.action, r.model, r.model_id])).toEqual(
      ['I', 'U', 'A', 'V', 'D'].map((action, i) => [before + 1 + i, action, 'DebugItem', id]),
    );
    expect(flushed.lastSyncId).toBe(before + 5);
    expect(await lastSyncId()).toBe(before + 5);
    // Full rows for I, U, A and V (an unarchive may re-insert a row a client dropped).
    expect(log.slice(0, 4).map((r) => r.data?.['title'])).toEqual(['One', 'Two', 'Two', 'Two']);
    expect(log[2]?.data?.['archivedAt']).toEqual(expect.stringMatching(/\.\d{3}Z$/));
    expect(log[3]?.data?.['archivedAt']).toBeNull();
    expect(log[4]?.data).toBeNull();
    expect(log.every((r) => r.groups.join() === 'workspace')).toBe(true);
  });

  it('logs a groups change as D for the old groups, then U for the new ones', async () => {
    const id = randomUUID();
    await inRepo((repo) =>
      repo.insert('DebugItem', { id, title: 'Moving', syncGroups: ['team:a'] }),
    );
    const before = await lastSyncId();
    await inRepo((repo) => repo.update('DebugItem', id, { syncGroups: ['team:b', 'workspace'] }));
    await inRepo((repo) => repo.update('DebugItem', id, { syncGroups: ['workspace', 'team:b'] }));

    expect((await logAfter(before)).map((r) => [r.action, r.groups, r.data === null])).toEqual([
      ['D', ['team:a'], true],
      ['U', ['team:b', 'workspace'], false],
      // The same set in another order is not a change of groups.
      ['U', ['workspace', 'team:b'], false],
    ]);
  });

  it('records the sync client that sent the mutation', async () => {
    const before = await lastSyncId();
    const clientId = randomUUID();
    await inRepo(
      (repo) =>
        repo.insert('DebugItem', { id: randomUUID(), title: 'x', syncGroups: ['workspace'] }),
      { clientId, seq: 42 },
    );
    expect((await logAfter(before)).map((r) => [r.client_id, Number(r.client_seq)])).toEqual([
      [clientId, 42],
    ]);
  });

  it('takes no lock and logs nothing when nothing changed', async () => {
    const before = await lastSyncId();
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const flushed = await syncRepo(drizzle({ client }), new Date()).flush({});
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid()
            AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [LOCKS.sync],
      );
      await client.query('COMMIT');
      expect(flushed).toEqual({});
      expect(rows[0]?.n).toBe(0);
    } finally {
      client.release();
    }
    expect(await lastSyncId()).toBe(before);
  });

  it('reports a missing row as NOT_FOUND and logs nothing', async () => {
    const before = await lastSyncId();
    await expect(
      inRepo((repo) => repo.update('DebugItem', randomUUID(), { title: 'x' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(inRepo((repo) => repo.purge('DebugItem', randomUUID()))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await lastSyncId()).toBe(before);
  });
});

describe('debug operations through the executor', () => {
  it('create, rename, touch and delete each log one change and return its sync id', async () => {
    const { executor } = testExecutor(h.pool);
    const id = randomUUID();
    const before = await lastSyncId();
    const results = [
      await executor.execute('debug.create', { id, title: 'Made' }, who.engMember),
      await executor.execute('debug.rename', { id, title: 'Renamed' }, who.engMember),
      await executor.execute('debug.touch', { id }, who.engMember),
      await executor.execute('debug.delete', { id }, who.engMember),
    ];
    expect(results.map((r) => (r.ok ? r.lastSyncId : r.error.code))).toEqual([
      before + 1,
      before + 2,
      before + 3,
      before + 4,
    ]);
    expect((await logAfter(before)).map((r) => [r.action, r.data?.['title'] ?? null])).toEqual([
      ['I', 'Made'],
      ['U', 'Renamed'],
      ['U', 'Renamed'],
      ['D', null],
    ]);
  });

  it('logs nothing for a rolled-back mutation or a query', async () => {
    const { executor } = testExecutor(h.pool);
    const id = randomUUID();
    await executor.execute('debug.create', { id, title: 'First' }, who.engMember);
    const before = await lastSyncId();

    const duplicate = await executor.execute('debug.create', { id, title: 'Again' }, who.engMember);
    const listed = await executor.execute('debug.listItems', {}, who.engMember);
    expect(duplicate.ok ? 'ok' : duplicate.error.code).toBe('CONFLICT');
    expect(listed.ok).toBe(true);
    expect('lastSyncId' in listed).toBe(false);
    expect(await lastSyncId()).toBe(before);
  });

  it('treats an item in a group the actor cannot see as missing', async () => {
    const { executor } = testExecutor(h.pool);
    const id = randomUUID();
    const secret = [`team:${h.teams.sec}`];
    await executor.execute('debug.create', { id, title: 'Secret', groups: secret }, who.secMember);
    const before = await lastSyncId();

    for (const [op, input] of [
      ['debug.rename', { id, title: 'Leaked' }],
      ['debug.delete', { id }],
    ] as const) {
      const result = await executor.execute(op, input, who.engMember);
      expect(result.ok ? 'ok' : [result.error.code, result.error.message]).toEqual([
        'NOT_FOUND',
        `Debug item ${id} not found.`,
      ]);
    }
    expect(await lastSyncId()).toBe(before);
  });
});
