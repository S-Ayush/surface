// SPEC-003 §7.1, §7.3: list, count and groupBy helpers. Keyset pages never skip or repeat rows
// (property test), visibility applies before everything (permissions.md §5), cursors are
// checked, and filter values may name teams like inputs do.
import { randomUUID } from 'node:crypto';
import { defineFilterFields, type Actor } from '@surface/domain';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { date, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import { defineFilterModel } from '../src/executor/filter-sql.js';
import {
  countQuery,
  defineListModel,
  groupByQuery,
  listQuery,
  type ListArgs,
  type ListContext,
} from '../src/executor/list.js';
import {
  actors,
  executorHarness,
  FIXTURE_SCHEMA,
  seedDebugItem,
  testExecutor,
  type ExecutorHarness,
} from './executor.js';
import { actorFor } from './helpers.js';

// ── Fixture model ────────────────────────────────────────────────────────────

const fixture = pgSchema(FIXTURE_SCHEMA);
const tasks = fixture.table('tasks', {
  id: uuid().primaryKey(),
  title: text(),
  teamId: uuid().notNull(),
  points: integer(),
  dueOn: date(),
  updatedAt: timestamp({ withTimezone: true, precision: 3 }),
  archivedAt: timestamp({ withTimezone: true, precision: 3 }),
  syncGroups: text().array().notNull(),
});

const taskList = defineListModel({
  table: tasks,
  filter: defineFilterModel({
    fields: defineFilterFields({
      title: { type: 'text' },
      team: { type: 'ref' },
      points: { type: 'number' },
    }),
    columns: () => ({
      title: sql`${tasks.title}`,
      team: sql`${tasks.teamId}`,
      points: sql`${tasks.points}`,
    }),
  }),
  filterRefs: { team: 'TeamRef' },
  order: { title: 'text', points: 'number', dueOn: 'day', updatedAt: 'instant' },
  defaultOrder: { field: 'updatedAt', direction: 'desc' },
  teamColumn: 'teamId',
  archivedColumn: 'archivedAt',
  groupings: (groups) => ({
    team: {
      key: sql`${tasks.teamId}::text`,
      label: sql`(SELECT t.name FROM public.teams t
        WHERE t.id = ${tasks.teamId} AND t.sync_groups && ${sql.param([...groups])}::text[])`,
    },
    points: { key: sql`${tasks.points}::text`, label: sql`${tasks.points}::text` },
    // A row in one group per word of its title, as an issue is in one group per label.
    word: {
      lateral: sql`unnest(CASE WHEN ${tasks.title} IS NULL THEN ARRAY[NULL]::text[]
        ELSE string_to_array(${tasks.title}, ' ') END) AS w(word)`,
      key: sql`w.word`,
      label: sql`w.word`,
    },
  }),
  estimateColumn: 'points',
});

let h: ExecutorHarness;
let client: pg.PoolClient;
let who: ReturnType<typeof actors>;

beforeAll(async () => {
  h = await executorHarness();
  await h.pool.query(`
    CREATE TABLE ${FIXTURE_SCHEMA}.tasks (
      id uuid PRIMARY KEY, title text, team_id uuid NOT NULL REFERENCES public.teams,
      points integer, due_on date, updated_at timestamptz(3), archived_at timestamptz(3),
      sync_groups text[] NOT NULL);
  `);
  client = await h.pool.connect();
  who = actors(h.teams);
});

afterAll(async () => {
  client.release();
  await h.close();
});

function ctxFor(actor: Actor): ListContext {
  return {
    tx: drizzle({ client, casing: 'snake_case' }),
    client,
    actor,
    filterContext: { now: Date.now(), timeZone: 'UTC', me: actor.userId ?? null },
  };
}

interface TaskSeed {
  id?: string;
  title?: string | null;
  team?: 'eng' | 'sec';
  points?: number | null;
  dueOn?: string | null;
  updatedAt?: string | null;
  archived?: boolean;
  /** Defaults to the team's: workspace for ENG, SEC's group for SEC. */
  groups?: string[];
}

async function seed(rows: readonly TaskSeed[]): Promise<string[]> {
  await client.query(`TRUNCATE ${FIXTURE_SCHEMA}.tasks`);
  const ids: string[] = [];
  for (const row of rows) {
    const id = row.id ?? randomUUID();
    const team = row.team ?? 'eng';
    const groups = row.groups ?? (team === 'eng' ? ['workspace'] : [`team:${h.teams.sec}`]);
    await client.query(
      `INSERT INTO ${FIXTURE_SCHEMA}.tasks VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        row.title === undefined ? 'Task' : row.title,
        h.teams[team],
        row.points ?? null,
        row.dueOn ?? null,
        row.updatedAt ?? null,
        row.archived ? '2026-01-01T00:00:00Z' : null,
        groups,
      ],
    );
    ids.push(id);
  }
  return ids;
}

async function failure(promise: Promise<unknown>): Promise<SurfaceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SurfaceError))
    throw new Error(`Expected a SurfaceError, got ${String(error)}`);
  return error;
}

/** Every page of a list, following cursors. */
async function allPages(actor: Actor, args: ListArgs): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const page = await listQuery(ctxFor(actor), taskList, {
      ...args,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(page.nodes.map((n) => n.id));
    if (!page.pageInfo.hasNextPage) {
      expect(page.pageInfo.endCursor === null).toBe(page.nodes.length === 0);
      return pages;
    }
    cursor = page.pageInfo.endCursor ?? undefined;
  }
  throw new Error('Pagination did not finish');
}

// ── Pagination ───────────────────────────────────────────────────────────────

const ORDER_FIELDS = ['title', 'points', 'dueOn', 'updatedAt'] as const;

/** The expected order, from one plain query over rows ENG members see. */
async function referenceOrder(field: string, direction: 'asc' | 'desc'): Promise<string[]> {
  const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM ${FIXTURE_SCHEMA}.tasks
      WHERE sync_groups && ARRAY['workspace'] AND archived_at IS NULL
      ORDER BY ${column} ${direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, id`,
  );
  return rows.map((r) => r.id);
}

describe('pagination', () => {
  it('returns every visible row exactly once, in order, for any sort and page size', async () => {
    // Few distinct values, so ties and nulls are common.
    const row = fc.record({
      title: fc.constantFrom(null, 'alpha', 'Alpha', 'beta', 'ß', 'Zed'),
      points: fc.constantFrom(null, -1, 0, 1, 2, 8),
      dueOn: fc.constantFrom(null, '2024-02-29', '2026-01-01', '2026-12-31'),
      updatedAt: fc.constantFrom(
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.001Z',
        '2026-03-29T01:30:00.999Z',
      ),
      hidden: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
      archived: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(row, { maxLength: 30 }),
        fc.constantFrom(...ORDER_FIELDS),
        fc.constantFrom('asc' as const, 'desc' as const),
        fc.integer({ min: 1, max: 7 }),
        async (rows, field, direction, limit) => {
          const ids = await seed(
            rows.map((r) => ({
              title: r.title,
              points: r.points,
              dueOn: r.dueOn,
              updatedAt: r.updatedAt,
              archived: r.archived,
              ...(r.hidden ? { groups: [`team:${h.teams.sec}`] } : {}),
            })),
          );
          const pages = await allPages(who.engMember, { orderBy: { field, direction }, limit });
          const seen = pages.flat();

          expect(seen).toEqual(await referenceOrder(field, direction));
          expect(new Set(seen)).toEqual(
            new Set(ids.filter((_, i) => !rows[i]?.hidden && !rows[i]?.archived)),
          );
          expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
        },
      ),
      { seed: 20261106, numRuns: 120 },
    );
  });

  it('sorts by the default order and adds the total only when asked', async () => {
    const [older, newer] = await seed([
      { updatedAt: '2026-01-01T00:00:00Z' },
      { updatedAt: '2026-02-01T00:00:00Z' },
      { groups: [`team:${h.teams.sec}`] },
    ]);
    const first = await listQuery(ctxFor(who.engMember), taskList, { limit: 1, withTotal: true });
    expect(first.nodes.map((n) => n.id)).toEqual([newer]);
    expect(first.totalCount).toBe(2);
    const plain = await listQuery(ctxFor(who.engMember), taskList, {});
    expect(plain.nodes.map((n) => n.id)).toEqual([newer, older]);
    expect(plain).not.toHaveProperty('totalCount');
    expect(plain.pageInfo.hasNextPage).toBe(false);
  });
});

describe('cursors and sort errors', () => {
  it('rejects a cursor that is not one of ours', async () => {
    await seed([{}]);
    const tampered = Buffer.from(
      JSON.stringify({ f: 'points', d: 'asc', k: '1; DROP TABLE tasks', i: randomUUID() }),
    ).toString('base64url');
    for (const cursor of ['garbage', 'e30', tampered]) {
      const error = await failure(
        listQuery(ctxFor(who.engMember), taskList, {
          orderBy: { field: 'points', direction: 'asc' },
          cursor,
        }),
      );
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(
        'This cursor is not valid. Use pageInfo.endCursor from the previous page.',
      );
      expect(error.details.issues?.[0]?.path).toEqual(['cursor']);
    }
  });

  it('rejects a cursor from a different sort order', async () => {
    await seed([{}, {}]);
    const page = await listQuery(ctxFor(who.engMember), taskList, { limit: 1 });
    const error = await failure(
      listQuery(ctxFor(who.engMember), taskList, {
        orderBy: { field: 'title', direction: 'asc' },
        cursor: page.pageInfo.endCursor ?? '',
      }),
    );
    expect(error.message).toBe(
      'This cursor belongs to a different sort order. Drop the cursor to start from the first page.',
    );
  });

  it('names the sortable fields for an unknown sort', async () => {
    const error = await failure(
      listQuery(ctxFor(who.engMember), taskList, {
        orderBy: { field: 'teamId', direction: 'asc' },
      }),
    );
    expect(error.message).toBe(
      'Can\'t sort by "teamId". Sort by one of: dueOn, points, title, updatedAt.',
    );
    expect(error.details.issues?.[0]?.path).toEqual(['orderBy', 'field']);
  });
});

// ── Visibility (permissions.md §5) ───────────────────────────────────────────

describe('visibility', () => {
  it('leaves rows outside the actor’s groups out of lists, counts and groups', async () => {
    const [eng, engHidden, sec] = await seed([
      { team: 'eng', points: 1 },
      // In a visible team, but its own groups hide it: only the row's groups decide.
      { team: 'eng', points: 5, groups: [`team:${h.teams.sec}`] },
      { team: 'sec', points: 3 },
    ]);
    const ctx = ctxFor(who.engMember);
    expect((await listQuery(ctx, taskList, {})).nodes.map((n) => n.id)).toEqual([eng]);
    expect(await countQuery(ctx, taskList, {})).toBe(1);
    expect(await groupByQuery(ctx, taskList, { groupBy: 'team' })).toEqual([
      { key: h.teams.eng, label: 'Engineering', count: 1, estimateSum: 1 },
    ]);
    // A filter can't reach hidden rows either.
    expect(
      await countQuery(ctx, taskList, { filter: { field: 'points', op: 'gte', value: 3 } }),
    ).toBe(0);

    const secCtx = ctxFor(who.secMember);
    expect(new Set((await listQuery(secCtx, taskList, {})).nodes.map((n) => n.id))).toEqual(
      new Set([eng, engHidden, sec]),
    );
  });

  it('limits an API key to its teams, public ones included', async () => {
    const [eng, sec] = await seed([{ team: 'eng' }, { team: 'sec' }]);
    const user = {
      id: randomUUID(),
      memberships: [
        { teamId: h.teams.eng, private: false },
        { teamId: h.teams.sec, private: true },
      ],
    };
    const secKey = actorFor(user, {
      kind: 'api',
      apiKey: { id: randomUUID(), scope: 'read', teamIds: [h.teams.sec], allowDestructive: false },
    });
    expect((await listQuery(ctxFor(secKey), taskList, {})).nodes.map((n) => n.id)).toEqual([sec]);
    expect(await countQuery(ctxFor(secKey), taskList, {})).toBe(1);
    // Without the key, the same user sees both.
    const unlimited = await listQuery(ctxFor(actorFor(user)), taskList, {});
    expect(new Set(unlimited.nodes.map((n) => n.id))).toEqual(new Set([eng, sec]));
  });

  it('hides archived rows unless asked', async () => {
    const [live, archived] = await seed([{}, { archived: true }]);
    const ctx = ctxFor(who.engMember);
    expect((await listQuery(ctx, taskList, {})).nodes.map((n) => n.id)).toEqual([live]);
    expect(await countQuery(ctx, taskList, {})).toBe(1);
    const all = await listQuery(ctx, taskList, { includeArchived: true });
    expect(new Set(all.nodes.map((n) => n.id))).toEqual(new Set([live, archived]));
    expect(await countQuery(ctx, taskList, { includeArchived: true })).toBe(2);
  });
});

// ── Filters ──────────────────────────────────────────────────────────────────

describe('filters', () => {
  it('resolves team keys in filter values, with the same visibility as inputs', async () => {
    const [eng, sec] = await seed([{ team: 'eng' }, { team: 'sec' }]);
    const byTeam = (actor: Actor, value: string | string[]) =>
      listQuery(ctxFor(actor), taskList, {
        filter: { field: 'team', op: Array.isArray(value) ? 'in' : 'eq', value },
      });
    expect((await byTeam(who.engMember, 'eng')).nodes.map((n) => n.id)).toEqual([eng]);
    expect((await byTeam(who.engMember, h.teams.eng)).nodes.map((n) => n.id)).toEqual([eng]);
    expect((await byTeam(who.secMember, 'SEC')).nodes.map((n) => n.id)).toEqual([sec]);

    // A private team's key is NOT_FOUND to outsiders, worded like a team that doesn't exist.
    const hidden = await failure(byTeam(who.engMember, 'SEC'));
    const missing = await failure(byTeam(who.engMember, 'NOPE'));
    expect(hidden.code).toBe('NOT_FOUND');
    expect(hidden.message).toBe(missing.message.replace('NOPE', 'SEC'));
    expect(hidden.details.issues?.[0]?.path).toEqual(['filter', 'value']);
  });

  it('points errors at the value inside the filter tree', async () => {
    await seed([{}]);
    const error = await failure(
      listQuery(ctxFor(who.engMember), taskList, {
        filter: {
          and: [
            { field: 'title', op: 'eq', value: 'x' },
            { field: 'team', op: 'in', value: ['ENG', 'NOPE'] },
          ],
        },
      }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details.issues?.[0]?.path).toEqual(['filter', 'and', 1, 'value', 1]);
  });

  it('reports a bad filter as INVALID_INPUT under "filter"', async () => {
    const error = await failure(
      countQuery(ctxFor(who.engMember), taskList, {
        filter: { field: 'colour', op: 'eq', value: 'red' },
      }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.issues?.[0]?.path[0]).toBe('filter');
  });
});

// ── groupBy ──────────────────────────────────────────────────────────────────

describe('groupBy', () => {
  it('counts and sums per group, largest first, with "None" for missing keys', async () => {
    await seed([
      { points: 2 },
      { points: 2 },
      { points: null },
      { points: 5 },
      { points: 5 },
      { points: 5 },
    ]);
    expect(await groupByQuery(ctxFor(who.engMember), taskList, { groupBy: 'points' })).toEqual([
      { key: '5', label: '5', count: 3, estimateSum: 15 },
      { key: '2', label: '2', count: 2, estimateSum: 4 },
      { key: null, label: 'None', count: 1, estimateSum: 0 },
    ]);
  });

  it('counts and sums a row in each of its groups for a per-value (lateral) grouping', async () => {
    await seed([
      { title: 'red blue', points: 2 },
      { title: 'red', points: 3 },
      { title: null, points: 1 },
    ]);
    expect(await groupByQuery(ctxFor(who.engMember), taskList, { groupBy: 'word' })).toEqual([
      { key: 'red', label: 'red', count: 2, estimateSum: 5 },
      { key: 'blue', label: 'blue', count: 1, estimateSum: 2 },
      { key: null, label: 'None', count: 1, estimateSum: 1 },
    ]);
  });

  it('names the groupings for an unknown one', async () => {
    const error = await failure(
      groupByQuery(ctxFor(who.engMember), taskList, { groupBy: 'colour' }),
    );
    expect(error.message).toBe('Can\'t group by "colour". Group by one of: points, team, word.');
  });
});

// ── Through the executor ─────────────────────────────────────────────────────

describe('debug.listItems', () => {
  it('pages through visible items and projects fields', async () => {
    const { executor } = testExecutor(h.pool);
    const visible = [
      await seedDebugItem(h.pool, { title: 'b' }),
      await seedDebugItem(h.pool, { title: 'a' }),
    ];
    await seedDebugItem(h.pool, { title: 'secret', groups: [`team:${h.teams.sec}`] });

    const input = { orderBy: { field: 'title' }, limit: 1 };
    const first = await executor.execute('debug.listItems', input, who.engMember, {
      fields: ['title'],
    });
    expect(first).toMatchObject({
      ok: true,
      result: { nodes: [{ title: 'a' }], pageInfo: { hasNextPage: true } },
    });
    if (!first.ok) return;
    const page = first.result as { nodes: object[]; pageInfo: { endCursor: string } };
    expect(page.nodes[0]).toEqual({ title: 'a' });

    const second = await executor.execute(
      'debug.listItems',
      { ...input, cursor: page.pageInfo.endCursor },
      who.engMember,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        nodes: [{ id: visible[0], title: 'b', counter: 0 }],
        pageInfo: { hasNextPage: false },
      },
    });
  });

  it('rejects unknown fields before running, with a suggestion', async () => {
    const { executor } = testExecutor(h.pool);
    const result = await executor.execute('debug.listItems', {}, who.engMember, {
      fields: ['titel'],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'debug.listItems has no field "titel". Did you mean "title"? Fields: counter, id, title, updatedAt.',
        issues: [{ path: ['fields', 0] }],
      },
    });
  });
});
