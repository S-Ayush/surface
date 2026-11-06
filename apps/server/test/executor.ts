/**
 * Executor test harness: a migrated database, fixture `teams` for reference resolution, the
 * real registry plus test-only operations, and helpers to seed debug items and read the outbox.
 */
import { randomUUID } from 'node:crypto';
import { TeamRef, type Actor } from '@surface/domain';
import {
  ALL_OPERATIONS,
  createRegistry,
  defineOperation,
  type AnyOperation,
} from '@surface/operations';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { pino } from 'pino';
import { z } from 'zod';
import { handler, type Handler } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import { createExecutor, type ExecutorDeps } from '../src/executor/execute.js';
import { passthroughRepo } from '../src/executor/repo.js';
import { HANDLERS } from '../src/handlers/index.js';
import { createTestDatabase, type TestDatabase } from './db.js';
import { actorFor, captureLogs } from './helpers.js';

export const FIXTURE_SCHEMA = 'exec_fixture';

export interface ExecutorHarness {
  db: TestDatabase;
  /** Pool whose connections see the fixture `teams` table. */
  pool: pg.Pool;
  teams: { eng: string; sec: string };
  close(): Promise<void>;
}

/** A migrated database with fixture teams: ENG (public) and SEC (private). */
export async function executorHarness(): Promise<ExecutorHarness> {
  const db = await createTestDatabase();
  const teams = { eng: randomUUID(), sec: randomUUID() };
  await db.pool.query(`
    CREATE SCHEMA ${FIXTURE_SCHEMA};
    CREATE TABLE ${FIXTURE_SCHEMA}.teams (
      id uuid PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL,
      private boolean NOT NULL, sync_groups text[] NOT NULL);
    -- Not synced: only here so a handler can hit a foreign-key violation (SPEC-003 Q6).
    CREATE TABLE ${FIXTURE_SCHEMA}.notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id uuid NOT NULL REFERENCES ${FIXTURE_SCHEMA}.teams (id));
  `);
  await db.pool.query(
    `INSERT INTO ${FIXTURE_SCHEMA}.teams VALUES
       ($1, 'ENG', 'Engineering', false, '{workspace}'),
       ($2, 'SEC', 'Security', true, $3)`,
    [teams.eng, teams.sec, [`team:${teams.sec}`]],
  );
  const pool = new pg.Pool({
    connectionString: db.url,
    max: 10,
    options: `-c search_path=${FIXTURE_SCHEMA},public`,
  });
  return {
    db,
    pool,
    teams,
    close: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Test-only operations (never registered outside tests)

export const calls = { teamNote: 0 };

/** A public (non-internal) mutation with a reference, a permission and validation. */
export const teamNote = defineOperation({
  name: 'debug.teamNote',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Add a note to a team',
  description: 'Test operation: needs a team member. Accepts a team key like ENG or a team id.',
  keywords: ['team note', 'annotate team'],
  input: z.object({ team: TeamRef, note: z.string().min(1).max(20) }),
  output: z.object({ team: z.string(), note: z.string() }),
  permission: (p, { team }) => p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', note: 'hi' }],
});

/** A handler that throws whatever the input asks for. */
export const explode = defineOperation({
  name: 'debug.explode',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Fail on purpose',
  description: 'Test operation that throws the requested kind of error.',
  keywords: ['fail', 'throw'],
  input: z.object({ kind: z.enum(['conflict', 'bug', 'badOutput']) }),
  output: z.object({ ok: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ kind: 'bug' }],
});

/** A query that writes, which the read-only transaction must stop (AC-4, E3). */
export const sneakyWrite = defineOperation({
  name: 'debug.sneakyWrite',
  kind: 'query',
  domain: 'debug',
  summary: 'Try to write from a query',
  description: 'Test operation: a query whose handler inserts a debug item.',
  keywords: ['write from query', 'read-only violation'],
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
});

/** Inserts a debug item with a given id (E7). */
export const createItem = defineOperation({
  name: 'debug.createItem',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Create a debug item',
  description: 'Test operation: inserts a workspace debug item with a client-chosen id.',
  keywords: ['create debug item', 'insert item'],
  input: z.object({ id: z.uuid(), title: z.string() }),
  output: z.object({ id: z.string() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', title: 'x' }],
});

/** Fails with a serialization error the first `failures` attempts (E5). */
export const flaky = defineOperation({
  name: 'debug.flaky',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Fail with serialization errors, then succeed',
  description: 'Test operation for the executor retry loop.',
  keywords: ['retry', 'serialization failure'],
  input: z.object({ failures: z.number().int().min(0) }),
  output: z.object({ attempts: z.number() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ failures: 1 }],
});

export const oldEcho = defineOperation({
  name: 'debug.oldEcho',
  kind: 'query',
  domain: 'debug',
  summary: 'Echo, the old way',
  description: 'Test operation marked deprecated (E8).',
  keywords: ['old echo', 'deprecated echo'],
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}],
  deprecated: { since: '0.1.0', replacedBy: 'debug.echo' },
});

/** A query with a team reference and no I/O in its handler (AC-11 with resolution). */
export const teamEcho = defineOperation({
  name: 'debug.teamEcho',
  kind: 'query',
  domain: 'debug',
  summary: 'Echo a team key',
  description: 'Test operation: resolves a team reference and returns its key.',
  keywords: ['team echo', 'resolve team'],
  input: z.object({ team: TeamRef }),
  output: z.object({ team: z.string() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ team: 'ENG' }],
});

/** Casts its input to uuid in SQL, so Postgres fails with a class-22 error quoting it. */
export const badCast = defineOperation({
  name: 'debug.badCast',
  kind: 'query',
  domain: 'debug',
  summary: 'Cast a value to uuid in SQL',
  description: 'Test operation: a bad cast must not put the value in the logs.',
  keywords: ['bad cast', 'invalid text representation'],
  input: z.object({ value: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ value: 'not-a-uuid' }],
});

/** Inserts a note for a team that doesn't exist: a foreign-key violation (23503). */
export const orphanNote = defineOperation({
  name: 'debug.orphanNote',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Add a note for a missing team',
  description: 'Test operation: stands in for a reference deleted after resolution.',
  keywords: ['orphan note', 'foreign key'],
  input: z.object({ teamId: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ teamId: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
});

let flakyAttempts = 0;
export function resetFlaky(): void {
  flakyAttempts = 0;
}

const TEST_HANDLERS: Handler[] = [
  handler(teamNote, (ctx, input) => {
    calls.teamNote++;
    const team = ctx.refs.team;
    const key = team !== undefined && 'key' in team ? String(team.key) : '?';
    if (team !== undefined && 'id' in team) {
      ctx.emit({ type: 'debug.noted', subject: { type: 'team', id: team.id }, changes: {} });
    }
    return Promise.resolve({ team: key, note: input.note });
  }),
  handler(explode, (_ctx, input) => {
    switch (input.kind) {
      case 'conflict':
        return Promise.reject(
          new SurfaceError('CONFLICT', 'That name is taken. Pick another one.'),
        );
      case 'bug':
        return Promise.reject(new Error('secret internal detail: password=hunter2'));
      case 'badOutput':
        // Deliberately breaks the output contract; only a cast can express that.
        return Promise.resolve({ ok: 'yes' as unknown as boolean });
    }
  }),
  handler(sneakyWrite, async (ctx, input) => {
    await ctx.repo.insert('DebugItem', {
      id: input.id,
      title: 'canary-title-7f3a',
      syncGroups: ['workspace'],
    });
    return { id: input.id };
  }),
  handler(createItem, async (ctx, input) => {
    const row = await ctx.repo.insert('DebugItem', {
      id: input.id,
      title: input.title,
      syncGroups: ['workspace'],
    });
    return { id: row.id };
  }),
  handler(flaky, (_ctx, input) => {
    flakyAttempts++;
    if (flakyAttempts <= input.failures) {
      return Promise.reject(
        Object.assign(new Error('could not serialize access'), { code: '40001' }),
      );
    }
    return Promise.resolve({ attempts: flakyAttempts });
  }),
  handler(oldEcho, () => Promise.resolve({ ok: true })),
  handler(teamEcho, (ctx) => {
    const team = ctx.refs.team;
    return Promise.resolve({ team: team !== undefined && 'key' in team ? String(team.key) : '?' });
  }),
  handler(badCast, async (ctx, input) => {
    await ctx.tx.execute(sql`SELECT ${input.value}::uuid`);
    return { ok: true };
  }),
  handler(orphanNote, async (ctx, input) => {
    await ctx.tx.execute(sql`INSERT INTO notes (team_id) VALUES (${input.teamId})`);
    return { ok: true };
  }),
];

export const TEST_OPERATIONS: readonly AnyOperation[] = [
  teamNote,
  explode,
  sneakyWrite,
  createItem,
  flaky,
  oldEcho,
  teamEcho,
  badCast,
  orphanNote,
];

/** An executor over the real registry plus the test operations, with captured logs. */
export function testExecutor(pool: pg.Pool, overrides: Partial<ExecutorDeps> = {}) {
  const logs = captureLogs();
  const log = pino({ level: 'info' }, logs.stream);
  const executor = createExecutor({
    pool,
    registry: createRegistry([...ALL_OPERATIONS, ...TEST_OPERATIONS]),
    handlers: [...HANDLERS, ...TEST_HANDLERS],
    log,
    allowInternal: true,
    backoff: () => 0,
    ...overrides,
  });
  return { executor, logs };
}

// ---------------------------------------------------------------------------------------------
// Actors and data

export function actors(teams: ExecutorHarness['teams']) {
  const engMember = actorFor({
    id: randomUUID(),
    memberships: [{ teamId: teams.eng, private: false }],
  });
  const outsider = actorFor({ id: randomUUID() });
  const secMember = actorFor({
    id: randomUUID(),
    memberships: [{ teamId: teams.sec, private: true }],
  });
  return { engMember, outsider, secMember };
}

/** Seeds a debug item through the repo layer, the way handlers write. */
export async function seedDebugItem(
  pool: pg.Pool,
  { groups = ['workspace'], title = 'Item' }: { groups?: string[]; title?: string } = {},
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repo = passthroughRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    const row = await repo.insert('DebugItem', { id: randomUUID(), title, syncGroups: groups });
    await client.query('COMMIT');
    return row.id;
  } finally {
    client.release();
  }
}

export async function counterOf(pool: pg.Pool, id: string): Promise<number | undefined> {
  const { rows } = await pool.query<{ counter: number }>(
    'SELECT counter FROM debug_items WHERE id = $1',
    [id],
  );
  return rows[0]?.counter;
}

export async function outboxFor(pool: pg.Pool, subjectId: string) {
  const { rows } = await pool.query<{
    type: string;
    actor: unknown;
    subject: unknown;
    changes: unknown;
  }>(
    `SELECT type, actor, subject, changes FROM event_outbox
      WHERE subject->>'id' = $1 ORDER BY id`,
    [subjectId],
  );
  return rows;
}

export type { Actor };
