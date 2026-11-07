/**
 * Executor test harness: a migrated database with two real teams (PLAN-001 S1) for reference
 * resolution, the real registry plus test-only operations, and helpers to seed debug items and
 * read the outbox.
 */
import { randomUUID } from 'node:crypto';
import { TeamRef, type Actor } from '@surface/domain';
import {
  ALL_OPERATIONS,
  createRegistry,
  defineOperation,
  type AnyOperation,
} from '@surface/operations';
import { getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { pino } from 'pino';
import { z } from 'zod';
import { handler, type Handler } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createExecutor,
  type ExecutorDeps,
  type PostHandlerCheck,
} from '../src/executor/execute.js';
import { SYNCED_MODELS } from '../src/sync/models.js';
import { syncRepo } from '../src/sync/repo.js';
import { HANDLERS } from '../src/handlers/index.js';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
import { createTestDatabase, type TestDatabase } from './db.js';
import { actorFor, captureLogs } from './helpers.js';

export const FIXTURE_SCHEMA = 'exec_fixture';

export interface ExecutorHarness {
  db: TestDatabase;
  /** Pool whose connections also see the fixture `notes` table. */
  pool: pg.Pool;
  teams: { eng: string; sec: string };
  close(): Promise<void>;
}

/** A migrated database with teams ENG (public) and SEC (private), each with its workflow. */
export async function executorHarness(): Promise<ExecutorHarness> {
  const db = await createTestDatabase();
  const teams = { eng: randomUUID(), sec: randomUUID() };
  await seedTeams(db.pool, [
    { id: teams.eng, key: 'ENG', name: 'Engineering', private: false },
    { id: teams.sec, key: 'SEC', name: 'Security', private: true },
  ]);
  await db.pool.query(`
    CREATE SCHEMA ${FIXTURE_SCHEMA};
    -- Not synced: only here so a handler can hit a foreign-key violation (SPEC-003 Q6).
    CREATE TABLE ${FIXTURE_SCHEMA}.notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id uuid NOT NULL REFERENCES public.teams (id));
  `);
  await auditSyncedWrites(db.pool);
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

/**
 * Real teams with their default workflow, written through the repo like `team.create` will, so
 * `sync_log` matches the tables. Before the write audit is installed.
 */
async function seedTeams(
  pool: pg.Pool,
  rows: readonly { id: string; key: string; name: string; private: boolean }[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const team of rows) {
      const workflow = teamWorkflow(team.id);
      await repo.insert('Team', {
        ...team,
        defaultStatusId: workflow.defaultStatusId,
        syncGroups: [],
      });
      await seedTeamWorkflow(repo, workflow);
    }
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// AC-12 (SPEC-002), runtime half: every write to a synced table is audited, and the test
// executor fails any mutation that wrote a row its repo didn't log. Known gaps, covered by the
// lint rule instead: it matches by (table, id), so a raw write to a row the repo also logged
// passes, and it doesn't audit `sync_log` / `sync_state` (only the repo's flush writes them).

const tableOfModel = new Map(
  Object.entries(SYNCED_MODELS).map(([model, { table }]) => [model, getTableName(table)]),
);

async function auditSyncedWrites(pool: pg.Pool): Promise<void> {
  const triggers = [...tableOfModel.values()].map(
    (table) => `CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON public.${table}
       FOR EACH ROW EXECUTE FUNCTION ${FIXTURE_SCHEMA}.audit_write();`,
  );
  await pool.query(`
    CREATE TABLE ${FIXTURE_SCHEMA}.write_audit (tx xid8 NOT NULL, tbl text NOT NULL, id uuid NOT NULL);
    CREATE FUNCTION ${FIXTURE_SCHEMA}.audit_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ${FIXTURE_SCHEMA}.write_audit
        VALUES (pg_current_xact_id(), TG_TABLE_NAME, CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
      RETURN NULL;
    END $$;
    ${triggers.join('\n')}
  `);
}

/** Fails a mutation that wrote a synced row its repo didn't log (a write around the repo). */
export const repoWritesOnly: PostHandlerCheck = async ({ op, tx, changes }) => {
  if (op.kind === 'query') return; // read-only: nothing to audit
  const { rows } = await tx.execute<{ tbl: string; id: string }>(sql`
    SELECT DISTINCT tbl, id::text AS id FROM ${sql.identifier(FIXTURE_SCHEMA)}.write_audit
    WHERE tx = pg_current_xact_id_if_assigned()`);
  const logged = new Set(changes.map((c) => `${tableOfModel.get(c.model)}:${c.id}`));
  const unlogged = rows.filter((r) => !logged.has(`${r.tbl}:${r.id}`));
  if (unlogged.length > 0) {
    const rowList = unlogged.map((r) => `${r.tbl} ${r.id}`).join(', ');
    throw new Error(`${op.name} wrote synced rows outside the repo layer: ${rowList}`);
  }
};

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

/** Updates a debug item with raw SQL, around the repo: the write audit must catch it. */
export const sideWrite = defineOperation({
  name: 'debug.sideWrite',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Write a debug item around the repo',
  description: 'Test operation: renames a debug item with raw SQL, so sync_log never hears of it.',
  keywords: ['write around repo', 'unlogged write'],
  input: z.object({ id: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
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
  handler(sideWrite, async (ctx, input) => {
    await ctx.tx.execute(sql`UPDATE debug_items SET title = 'unlogged' WHERE id = ${input.id}`);
    return { ok: true };
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
  sideWrite,
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
    // A test's own checks run after the write audit, never instead of it.
    checks: [repoWritesOnly, ...(overrides.checks ?? [])],
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
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    const row = await repo.insert('DebugItem', { id: randomUUID(), title, syncGroups: groups });
    await repo.flush({});
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
