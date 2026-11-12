// PLAN-002 S5: `POST /sync/mutate` (SPEC-002 §4.4, sync-protocol §4.4) through the real route and
// executor, over a stand-in connection that keeps `client_mutations` and a write counter with
// transaction, savepoint and commit semantics. No database (new integration tests are held, plans
// README §6): the SQL itself was checked by hand against Postgres (PLAN-002 S5 As built), and the
// sync property suite runs against the real server (session D).
import { randomUUID } from 'node:crypto';
import { createRegistry, defineOperation } from '@surface/operations';
import {
  MAX_MUTATION_BATCH_BYTES,
  MUTATE_PATH,
  decodeMutateErrorBody,
  decodeMutateResponse,
  type Mutation,
  type MutationResult,
} from '@surface/sync-protocol';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import type { Pool } from '../src/db/pool.js';
import { handler } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import { createExecutor } from '../src/executor/execute.js';
import type { RateLimiter } from '../src/executor/rate-limit.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRegistry } from '../src/sync/registry.js';
import type { RepoFactory } from '../src/sync/repo.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

const count = defineOperation({
  name: 'debug.count',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Count a key (test only)',
  description: 'Test fixture: one write per call, then what `then` says.',
  keywords: ['test', 'count'],
  input: z.object({
    key: z.string(),
    then: z
      .enum(['ok', 'notFound', 'bug', 'nothing', 'deadlockOnce', 'conflictWithIssues'])
      .default('ok'),
  }),
  output: z.object({}),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ key: 'a' }],
  internal: true,
});

const peek = defineOperation({
  name: 'debug.peek',
  kind: 'query',
  domain: 'debug',
  summary: 'Read nothing (test only)',
  description: 'Test fixture: a query.',
  keywords: ['test', 'query'],
  input: z.object({}),
  output: z.object({}),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}],
  internal: true,
});

const SCHEMA_HASH = syncRegistry({ includeFixtures: true }).schemaHash;
const ada = actorFor({ id: randomUUID() });
const bob = actorFor({ id: randomUUID() });
const key = actorFor(
  { id: randomUUID() },
  {
    kind: 'api',
    apiKey: { id: randomUUID(), scope: 'read_write', teamIds: [], allowDestructive: false },
  },
);

interface Ledger {
  userId: string;
  lastSeq: number;
  results: MutationResult[];
}

interface LogRow {
  syncId: number;
  model: string;
  groups: readonly string[];
}

interface State {
  ledger: Map<string, Ledger>;
  /** `sync_state.last_sync_id`. */
  head: number;
  /** `sync_log`: what each row's readers need to know. */
  log: LogRow[];
  /** Committed writes per key: how often each mutation really ran. */
  counts: Map<string, number>;
  /** Writes since the last flush. */
  unflushed: number;
}

const clone = (s: State): State => ({
  ledger: new Map([...s.ledger].map(([id, l]) => [id, { ...l, results: [...l.results] }])),
  head: s.head,
  log: [...s.log],
  counts: new Map(s.counts),
  unflushed: s.unflushed,
});

/**
 * One connection over an in-memory database: what a transaction does is visible only to it until
 * COMMIT, and ROLLBACK TO SAVEPOINT undoes what came after the savepoint. Kept across apps, so a
 * "restarted" server finds what the last one committed.
 */
function fakeDatabase() {
  let committed: State = { ledger: new Map(), head: 0, log: [], counts: new Map(), unflushed: 0 };
  let tx: State | undefined;
  let savepoint: State | undefined;
  const statements: string[] = [];
  /** Fails the next `connect()` (the server is gone) or the next COMMIT, once each. */
  const faults = { connect: false, commit: undefined as Error | undefined };

  const inTx = (): State => {
    if (!tx) throw new Error('statement outside a transaction');
    return tx;
  };

  const client = {
    query(text: string, values: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      statements.push(sql.split(' ').slice(0, 3).join(' '));
      const rows = (r: unknown[] = []) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.startsWith('BEGIN')) {
        tx = clone(committed);
        return rows();
      }
      if (sql === 'COMMIT') {
        const failure = faults.commit;
        faults.commit = undefined;
        if (failure) return Promise.reject(failure);
        committed = inTx();
        tx = undefined;
        return rows();
      }
      if (sql === 'ROLLBACK') {
        tx = undefined;
        return rows();
      }
      if (sql === 'SAVEPOINT mutation') {
        savepoint = clone(inTx());
        return rows();
      }
      if (sql === 'ROLLBACK TO SAVEPOINT mutation') {
        if (!savepoint) throw new Error('no savepoint');
        tx = clone(savepoint);
        return rows();
      }
      const [first, second, third] = values;
      if (sql.startsWith('SELECT user_id::text AS user_id, last_seq::text')) {
        const entry = inTx().ledger.get(String(first));
        if (!entry) return rows();
        const stored = entry.results.find((r) => String(r.seq) === second) ?? null;
        return rows([{ user_id: entry.userId, last_seq: String(entry.lastSeq), stored }]);
      }
      if (sql.startsWith('INSERT INTO client_mutations')) {
        const state = inTx();
        const id = String(first);
        if (!state.ledger.has(id)) {
          state.ledger.set(id, { userId: String(second), lastSeq: 0, results: [] });
        }
        return rows();
      }
      if (sql.startsWith('UPDATE client_mutations SET')) {
        const entry = inTx().ledger.get(String(first));
        if (!entry) throw new Error('no client row');
        const seq = Number(second);
        const result = JSON.parse(String(third)) as MutationResult;
        entry.lastSeq = seq;
        entry.results = [...entry.results, result].filter((r) => r.seq > seq - 100);
        return rows();
      }
      if (sql.startsWith('SELECT sync_id::text AS sync_id FROM sync_log')) {
        const groups = first as readonly string[];
        const models = second as readonly string[];
        const visible = inTx().log.filter(
          (row) => row.groups.some((g) => groups.includes(g)) && models.includes(row.model),
        );
        const newest = visible.at(-1);
        return rows(newest ? [{ sync_id: String(newest.syncId) }] : []);
      }
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
    release() {},
  };

  const pool = {
    connect: () => {
      if (faults.connect) {
        faults.connect = false;
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      return Promise.resolve(client);
    },
  } as unknown as Pool;

  /** A repo whose only effect is the counter; `flush` takes sync ids like the real one. */
  const repoFactory: RepoFactory = () => ({
    insert: () => Promise.reject(new Error('not used')),
    update: () => Promise.reject(new Error('not used')),
    archive: () => Promise.reject(new Error('not used')),
    unarchive: () => Promise.reject(new Error('not used')),
    purge: () => Promise.reject(new Error('not used')),
    updateWhere: () => Promise.reject(new Error('not used')),
    deleteWhere: () => Promise.reject(new Error('not used')),
    changes: () => [],
    unloggedDeletes: () => [],
    flush: () => {
      const state = inTx();
      if (state.unflushed === 0) return Promise.resolve({});
      for (let i = 0; i < state.unflushed; i++) {
        state.log.push({ syncId: ++state.head, model: 'DebugItem', groups: ['workspace'] });
      }
      state.unflushed = 0;
      return Promise.resolve({ lastSyncId: state.head });
    },
  });

  return {
    pool,
    repoFactory,
    statements,
    faults,
    /** The handler's write, in the open transaction. */
    write(name: string) {
      const state = inTx();
      state.counts.set(name, (state.counts.get(name) ?? 0) + 1);
      state.unflushed++;
    },
    committed: () => committed,
    /** A row another client committed. */
    commitElsewhere(row: { model: string; groups: readonly string[] }) {
      committed.head += 1;
      committed.log.push({ syncId: committed.head, ...row });
    },
  };
}

type FakeDatabase = ReturnType<typeof fakeDatabase>;

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function server(
  db: FakeDatabase,
  options: {
    rateLimiter?: RateLimiter;
    ready?: boolean;
    logs?: ReturnType<typeof captureLogs>;
  } = {},
) {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const logs = options.logs ?? captureLogs();
  const logger = createLogger(config, logs.stream);
  const registry = createRegistry([count, peek]);
  const resolveActor = headerActor({ ada, bob, key });
  const deadlocked = new Set<string>();
  // Bootstrap is registered next to mutate and needs a pool; nothing here reaches it.
  const unused = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
  const app = await buildApp({
    config,
    lifecycle,
    logger,
    sync: { pool: unused, registry: syncRegistry({ includeFixtures: true }), resolveActor },
    ops: {
      registry,
      resolveActor,
      createExecutor: () =>
        createExecutor({
          pool: db.pool,
          registry,
          handlers: [
            handler(count, (_ctx, input) => {
              if (input.then === 'nothing') return Promise.resolve({});
              db.write(input.key);
              if (input.then === 'notFound') {
                throw new SurfaceError('NOT_FOUND', `Item ${input.key} was not found.`);
              }
              if (input.then === 'bug') throw new Error('the handler has a bug: secret-internals');
              if (input.then === 'conflictWithIssues') {
                throw new SurfaceError('CONFLICT', `Key ${input.key} is taken.`, {
                  issues: [
                    { path: ['key'], message: 'This key is taken.', hint: 'Try another key.' },
                    { path: ['tags', 0], message: 'This tag is taken too.' },
                  ],
                  candidates: [{ id: randomUUID(), label: 'secret-candidate' }],
                });
              }
              if (input.then === 'deadlockOnce' && !deadlocked.has(input.key)) {
                deadlocked.add(input.key);
                throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
              }
              return Promise.resolve({});
            }),
            handler(peek, () => Promise.resolve({})),
          ],
          log: logger,
          allowInternal: true,
          backoff: () => 0,
          repoFactory: db.repoFactory,
          // The engine fixture is what this test's operations write.
          syncedModels: ['DebugItem'],
          ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
        }),
    },
  });
  if (options.ready !== false) lifecycle.markReady();
  cleanup.push(async () => {
    await app.close();
    await unused.end();
  });
  return app;
}

type App = Awaited<ReturnType<typeof server>>;

const op = (seq: number, input: Record<string, unknown>, name = 'debug.count'): Mutation => ({
  seq,
  op: name,
  input: input as Mutation['input'],
});

/** The user each test actor signs in as: by default, a queue belongs to whoever sends it. */
const USER_OF: Readonly<Record<string, string | undefined>> = {
  ada: ada.userId,
  bob: bob.userId,
  key: key.userId,
};

function send(
  app: App,
  mutations: Mutation[],
  {
    clientId,
    as = 'ada',
    schemaHash = SCHEMA_HASH,
    userId = USER_OF[as] ?? randomUUID(),
  }: {
    clientId: string;
    as?: string;
    schemaHash?: string;
    /** The queue's user (SPEC-002 E14); `null` leaves it out, as a client before v0.5 does. */
    userId?: string | null;
  },
) {
  return app.inject({
    method: 'POST',
    url: MUTATE_PATH,
    headers: { 'x-test-actor': as },
    payload: { clientId, ...(userId === null ? {} : { userId }), schemaHash, mutations },
  });
}

async function results(
  app: App,
  mutations: Mutation[],
  options: { clientId: string; as?: string },
): Promise<MutationResult[]> {
  const response = await send(app, mutations, options);
  expect(response.statusCode, response.body).toBe(200);
  return decodeMutateResponse(response.json()).results;
}

const counts = (db: FakeDatabase) => Object.fromEntries(db.committed().counts);

describe('POST /sync/mutate', () => {
  it('runs a batch in seq order, one transaction per mutation, and records each seq with it', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    expect(
      await results(app, [op(1, { key: 'a' }), op(2, { key: 'b' }), op(3, { key: 'a' })], {
        clientId,
      }),
    ).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
      { seq: 2, status: 'ok', lastSyncId: 2 },
      { seq: 3, status: 'ok', lastSyncId: 3 },
    ]);
    expect(counts(db)).toEqual({ a: 2, b: 1 });
    expect(db.committed().ledger.get(clientId)).toMatchObject({ userId: ada.userId, lastSeq: 3 });
    // The client's row is locked before anything else in each transaction, and the seq is
    // recorded before that transaction commits.
    const begins = db.statements.filter((s) => s.startsWith('BEGIN')).length;
    const commits = db.statements.filter((s) => s === 'COMMIT').length;
    expect([begins, commits]).toEqual([3, 3]);
    const first = db.statements.slice(0, db.statements.indexOf('COMMIT') + 1);
    expect(first[1]).toMatch(/^SELECT user_id::text/);
    expect(first.at(-2)).toBe('UPDATE client_mutations SET');
  });

  it('returns the stored results of a resent batch without running it again', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    const batch = [op(1, { key: 'a' }), op(2, { key: 'gone', then: 'notFound' })];
    const first = await results(app, batch, { clientId });
    expect(await results(app, batch, { clientId })).toEqual(first);
    expect(counts(db)).toEqual({ a: 1 });
    expect(db.committed().head).toBe(1);
  });

  it('replays the seqs it has and runs the rest when a resent batch grew', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    await results(app, [op(1, { key: 'a' }), op(2, { key: 'a' })], { clientId });
    expect(
      await results(app, [op(1, { key: 'a' }), op(2, { key: 'a' }), op(3, { key: 'b' })], {
        clientId,
      }),
    ).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
      { seq: 2, status: 'ok', lastSyncId: 2 },
      { seq: 3, status: 'ok', lastSyncId: 3 },
    ]);
    expect(counts(db)).toEqual({ a: 2, b: 1 });
  });

  it('answers 400 SEQ_GAP with the last seq processed, and runs nothing, when a batch skips ahead', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    const fresh = await send(app, [op(2, { key: 'a' })], { clientId });
    expect(fresh.statusCode).toBe(400);
    expect(decodeMutateErrorBody(fresh.json()).error).toMatchObject({
      code: 'SEQ_GAP',
      lastSeq: 0,
    });

    await results(app, [op(1, { key: 'a' }), op(2, { key: 'a' })], { clientId });
    const ahead = await send(app, [op(4, { key: 'b' }), op(5, { key: 'b' })], { clientId });
    expect(ahead.statusCode).toBe(400);
    expect(decodeMutateErrorBody(ahead.json()).error).toMatchObject({
      code: 'SEQ_GAP',
      message: 'Expected change 3 next. Resend from there.',
      lastSeq: 2,
    });
    expect(counts(db)).toEqual({ a: 2 });
    expect(db.committed().ledger.get(clientId)?.lastSeq).toBe(2);
  });

  it('records a rejected mutation with its error, undoes its writes, and runs the rest of the batch', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    const batch = [
      op(1, { key: 'gone', then: 'notFound' }),
      op(2, { key: 'a' }),
      op(3, { nope: true }),
      op(4, {}, 'debug.missing'),
      op(5, {}, 'debug.peek'),
    ];
    const got = await results(app, batch, { clientId });
    expect(got).toEqual([
      {
        seq: 1,
        status: 'error',
        error: { code: 'NOT_FOUND', message: 'Item gone was not found.' },
      },
      { seq: 2, status: 'ok', lastSyncId: 1 },
      {
        seq: 3,
        status: 'error',
        error: {
          code: 'INVALID_INPUT',
          message: expect.stringContaining('key') as string,
          issues: [{ path: ['key'], message: expect.any(String) as string }],
        },
      },
      {
        seq: 4,
        status: 'error',
        error: {
          code: 'UNKNOWN_OPERATION',
          message: expect.stringContaining('debug.missing') as string,
        },
      },
      {
        seq: 5,
        status: 'error',
        error: { code: 'INVALID_INPUT', message: expect.stringContaining('is a query') as string },
      },
    ]);
    // The rejected write rolled back to its savepoint; the seq was still recorded.
    expect(counts(db)).toEqual({ a: 1 });
    expect(db.committed().ledger.get(clientId)?.lastSeq).toBe(5);
    expect(await results(app, batch, { clientId })).toEqual(got);
  });

  it('sends a rejection’s issues as the operations API does, without candidates, and replays them', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    const batch = [op(1, { key: 'taken', then: 'conflictWithIssues' })];
    const response = await send(app, batch, { clientId });
    expect(response.statusCode).toBe(200);
    const expected = {
      results: [
        {
          seq: 1,
          status: 'error',
          error: {
            code: 'CONFLICT',
            message: 'Key taken is taken.',
            issues: [
              { path: ['key'], message: 'This key is taken.', hint: 'Try another key.' },
              { path: ['tags', 0], message: 'This tag is taken too.' },
            ],
          },
        },
      ],
    };
    // Exactly this: no `candidates`, `operation` or `correlationId` on the wire.
    expect(response.json()).toEqual(expected);
    expect(response.body).not.toContain('secret-candidate');
    // Kept with the stored result, so a resend gets the same answer.
    expect(db.committed().ledger.get(clientId)?.results).toEqual(expected.results);
    const resent = await send(app, batch, { clientId });
    expect(resent.json()).toEqual(expected);
    expect(counts(db)).toEqual({});
  });

  it('records a handler bug as rejected without showing its internals, and logs it', async () => {
    const db = fakeDatabase();
    const logs = captureLogs();
    const app = await server(db, { logs });
    const clientId = randomUUID();
    const [result] = await results(app, [op(1, { key: 'a', then: 'bug' })], { clientId });
    expect(result).toEqual({
      seq: 1,
      status: 'error',
      error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-internals');
    expect(logs.text()).toContain('secret-internals');
    expect(counts(db)).toEqual({});
  });

  it('confirms a mutation that changed nothing at the newest row its client receives', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    db.commitElsewhere({ model: 'DebugItem', groups: ['workspace'] }); // 1: seen
    db.commitElsewhere({ model: 'DebugItem', groups: [`user:${ada.userId}`] }); // 2: seen
    db.commitElsewhere({ model: 'DebugItem', groups: [`user:${bob.userId}`] }); // 3: someone else's
    db.commitElsewhere({
      model: 'DebugItem',
      groups: ['team:0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e'],
    }); // 4: a private team
    db.commitElsewhere({ model: 'Unsynced', groups: ['workspace'] }); // 5: a model not synced
    const clientId = randomUUID();
    // Ada's replica never reaches 5, and nothing she can't see confirms her change (no ack: it
    // logged nothing), so 2 is where it is confirmed.
    expect(await results(app, [op(1, { key: 'a', then: 'nothing' })], { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 2 },
    ]);
    // Bob receives his own row, 3.
    expect(
      await results(app, [op(1, { key: 'a', then: 'nothing' })], {
        clientId: randomUUID(),
        as: 'bob',
      }),
    ).toEqual([{ seq: 1, status: 'ok', lastSyncId: 3 }]);
    // On an empty log, 0: confirmed at once.
    const empty = fakeDatabase();
    expect(
      await results(await server(empty), [op(1, { key: 'a', then: 'nothing' })], {
        clientId: randomUUID(),
      }),
    ).toEqual([{ seq: 1, status: 'ok', lastSyncId: 0 }]);
  });

  it('answers a stored result it can no longer read as already processed, rather than failing the request', async () => {
    const db = fakeDatabase();
    const logs = captureLogs();
    const app = await server(db, { logs });
    const clientId = randomUUID();
    await results(app, [op(1, { key: 'a' })], { clientId });
    const entry = db.committed().ledger.get(clientId);
    if (!entry) throw new Error('no ledger row');
    entry.results = [{ seq: 1, status: 'unknown' } as unknown as MutationResult];
    expect(await results(app, [op(1, { key: 'a' })], { clientId })).toEqual([
      {
        seq: 1,
        status: 'error',
        error: {
          code: 'CONFLICT',
          message: expect.stringContaining('already processed') as string,
        },
      },
    ]);
    expect(logs.text()).toContain('stored mutation result is unreadable');
    expect(counts(db)).toEqual({ a: 1 });
  });

  it('runs each mutation once when the server dies after a commit and the batch is resent to a new one', async () => {
    const db = fakeDatabase();
    const clientId = randomUUID();
    const batch = [op(1, { key: 'a' }), op(2, { key: 'b' }), op(3, { key: 'c' })];
    const before = await server(db);
    // Seq 1 commits; the connection for seq 2 never comes: the process is going away.
    let connects = 0;
    const connect = db.pool.connect.bind(db.pool);
    db.pool.connect = (() => {
      if (++connects === 2) db.faults.connect = true;
      return connect();
    }) as typeof db.pool.connect;
    const lost = await send(before, batch, { clientId });
    expect(lost.statusCode).toBe(500);
    expect(counts(db)).toEqual({ a: 1 });

    const after = await server(db);
    expect(await results(after, batch, { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
      { seq: 2, status: 'ok', lastSyncId: 2 },
      { seq: 3, status: 'ok', lastSyncId: 3 },
    ]);
    expect(counts(db)).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('records nothing when the commit itself fails, so the resend runs the mutation once', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    db.faults.commit = new Error('Connection terminated unexpectedly');
    const failed = await send(app, [op(1, { key: 'a' })], { clientId });
    expect(failed.statusCode).toBe(500);
    expect(db.committed().ledger.has(clientId)).toBe(false);
    expect(await results(app, [op(1, { key: 'a' })], { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
    ]);
    expect(counts(db)).toEqual({ a: 1 });
  });

  it('reruns a mutation whose commit hit a serialization failure, and records it once', async () => {
    const db = fakeDatabase();
    let taken = 0;
    const app = await server(db, {
      rateLimiter: { take: () => (taken++, { allowed: true }) },
    });
    const clientId = randomUUID();
    db.faults.commit = Object.assign(new Error('could not serialize access'), { code: '40001' });
    expect(await results(app, [op(1, { key: 'a' })], { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
    ]);
    expect(counts(db)).toEqual({ a: 1 });
    // The second attempt doesn't take another token.
    expect(taken).toBe(1);
  });

  it('reruns a mutation whose handler hit a deadlock, rather than recording it as rejected', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    expect(await results(app, [op(1, { key: 'a', then: 'deadlockOnce' })], { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
    ]);
    expect(counts(db)).toEqual({ a: 1 });
  });

  it('stops the batch at a rate limit with 429 and Retry-After; what committed is replayed on resend', async () => {
    const db = fakeDatabase();
    let allowed = 1;
    const app = await server(db, {
      rateLimiter: {
        take: () => (allowed-- > 0 ? { allowed: true } : { allowed: false, retryAfterSeconds: 7 }),
      },
    });
    const clientId = randomUUID();
    const batch = [op(1, { key: 'a' }), op(2, { key: 'b' }), op(3, { key: 'c' })];
    const limited = await send(app, batch, { clientId });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('7');
    expect(decodeMutateErrorBody(limited.json()).error.code).toBe('RATE_LIMITED');
    // Seq 2 was not recorded as rejected: it runs when the batch is resent.
    expect(db.committed().ledger.get(clientId)?.lastSeq).toBe(1);

    allowed = 2;
    expect(await results(app, batch, { clientId })).toEqual([
      { seq: 1, status: 'ok', lastSyncId: 1 },
      { seq: 2, status: 'ok', lastSyncId: 2 },
      { seq: 3, status: 'ok', lastSyncId: 3 },
    ]);
    expect(counts(db)).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('answers 426 CLIENT_OUTDATED to a client with another schema hash, and runs nothing', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const response = await send(app, [op(1, { key: 'a' })], {
      clientId: randomUUID(),
      schemaHash: 'f'.repeat(64),
    });
    expect(response.statusCode).toBe(426);
    expect(decodeMutateErrorBody(response.json()).error.code).toBe('CLIENT_OUTDATED');
    expect(db.statements).toEqual([]);
  });

  it('registers a client to the user who first uses it, and refuses it to anyone else', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    await results(app, [op(1, { key: 'a' })], { clientId });
    const stranger = await send(app, [op(1, { key: 'b' }), op(2, { key: 'b' })], {
      clientId,
      as: 'bob',
    });
    expect(stranger.statusCode).toBe(403);
    expect(decodeMutateErrorBody(stranger.json()).error).toMatchObject({
      code: 'FORBIDDEN',
      message: "This clientId belongs to another user. Use a new clientId for this user's changes.",
    });
    // Not even the stored result of seq 1 is shown.
    expect(stranger.body).not.toContain('lastSyncId');
    expect(counts(db)).toEqual({ a: 1 });
    expect(db.committed().ledger.get(clientId)).toMatchObject({ userId: ada.userId, lastSeq: 1 });
  });

  it('is for signed-in users only: 401 without a session, 403 for an API key, 503 while starting', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    expect((await send(app, [op(1, { key: 'a' })], { clientId, as: 'nobody' })).statusCode).toBe(
      401,
    );
    const viaKey = await send(app, [op(1, { key: 'a' })], { clientId, as: 'key' });
    expect(viaKey.statusCode).toBe(403);
    expect(viaKey.json()).toMatchObject({
      error: { message: expect.stringContaining('operations API') as string },
    });
    const starting = await server(db, { ready: false });
    expect((await send(starting, [op(1, { key: 'a' })], { clientId })).statusCode).toBe(503);
    expect(db.statements).toEqual([]);
  });

  it('refuses another user’s queue with 401 before running or registering anything (SPEC-002 E14)', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    // A queue that only ever queued offline: nobody has registered its clientId yet.
    const fresh = randomUUID();
    const unregistered = await send(app, [op(1, { key: 'a' })], {
      clientId: fresh,
      as: 'bob',
      userId: ada.userId ?? '',
    });
    expect(unregistered.statusCode).toBe(401);
    expect(decodeMutateErrorBody(unregistered.json()).error.code).toBe('UNAUTHENTICATED');
    expect(db.statements).toEqual([]);
    expect(db.committed().ledger.has(fresh)).toBe(false);
    // Ada's registered queue under Bob's cookie: 401 too, not the 403 for a foreign clientId.
    const adas = randomUUID();
    await results(app, [op(1, { key: 'a' })], { clientId: adas });
    const registered = await send(app, [op(2, { key: 'b' })], {
      clientId: adas,
      as: 'bob',
      userId: ada.userId ?? '',
    });
    expect(registered.statusCode).toBe(401);
    expect(counts(db)).toEqual({ a: 1 });
  });

  it('answers 426 CLIENT_OUTDATED to a body without userId (before v0.5), even a malformed one', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    for (const mutations of [[op(1, { key: 'a' })], [op(2, { key: 'a' }), op(1, { key: 'a' })]]) {
      const response = await send(app, mutations, { clientId, userId: null });
      expect(response.statusCode).toBe(426);
      // Old queues act on the code: anything else would reject their changes one by one.
      expect(decodeMutateErrorBody(response.json()).error.code).toBe('CLIENT_OUTDATED');
    }
    expect(db.statements).toEqual([]);
  });

  it('refuses a malformed batch with 400 and a body over 1 MiB with 413, running nothing', async () => {
    const db = fakeDatabase();
    const app = await server(db);
    const clientId = randomUUID();
    const unordered = await send(app, [op(2, { key: 'a' }), op(1, { key: 'a' })], { clientId });
    expect(unordered.statusCode).toBe(400);
    expect(unordered.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const big = await send(app, [op(1, { key: 'x'.repeat(MAX_MUTATION_BATCH_BYTES) })], {
      clientId,
    });
    expect(big.statusCode).toBe(413);
    expect(db.statements).toEqual([]);
  });
});
