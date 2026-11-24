// SPEC-011 AC-11 (PLAN-011 S8; Q13 exception, not held): for the Issue model, the client evaluator
// (`filterIssues`, `@surface/domain`) and the SQL compiler (`issueListModel.filter`) answer every
// generated filter alike. Both read `ISSUE_FILTER_FIELDS`. The PLAN-003 S5 harness
// (`filter-conformance.int.test.ts`) on the real tables: rows are inserted into `issues` of a
// migrated database in a transaction that is rolled back, and the client reads them as a replica
// would, through the real codec (`selectRows`, `clientRow`, NDJSON, the `Issue` row schema). The
// replica holds the statuses of the actor's groups only, so a SEC status has no category on the
// client, and the compiler must not find one either.
import { randomUUID } from 'node:crypto';
import {
  filterIssues,
  ISSUE_FILTER_FIELDS,
  OPS_BY_TYPE,
  type Filter,
  type FilterContext,
  type FilterOp,
} from '@surface/domain';
import { Issue } from '@surface/domain/model';
import { encodeNdjsonLine } from '@surface/sync-protocol';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/db/uuidv7.js';
import { compileFilter, type VisibilityScope } from '../src/executor/filter-sql.js';
import { issueListModel } from '../src/handlers/issues/list-model.js';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
import { GROUPS_ALIAS, rowsWhere, selectRows } from '../src/sync/bootstrap.js';
import { clientRow, syncRegistry } from '../src/sync/registry.js';
import { syncRepo } from '../src/sync/repo.js';
import { createTestDatabase, type TestDatabase } from './db.js';

type FieldName = keyof typeof ISSUE_FILTER_FIELDS;
const FIELD_NAMES = Object.keys(ISSUE_FILTER_FIELDS).filter(
  (name): name is FieldName => name in ISSUE_FILTER_FIELDS,
);

const issueModel = syncRegistry({ includeFixtures: false }).models.find((m) => m.name === 'Issue');
if (issueModel === undefined) throw new Error('The registry has no Issue model');
const dialect = new PgDialect({ casing: 'snake_case' });

// ── Fixtures: users, public ENG and private SEC with their workflows ─────────

const USERS = [randomUUID(), randomUUID(), randomUUID()] as const;
const ENG = randomUUID();
const SEC = randomUUID();
const engWorkflow = teamWorkflow(ENG);
const secWorkflow = teamWorkflow(SEC);
/** Label ids: the array has no foreign key, and a user id may stand in one (`me`). */
const LABELS = [uuidv7(), uuidv7(), uuidv7(), USERS[0]] as const;

/** The actor (USERS[0]) sees the workspace, ENG and its own issues; not SEC. */
const SCOPE: VisibilityScope = { groups: ['workspace', `team:${ENG}`, `user:${USERS[0]}`] };
/** The replica: only the statuses in the actor's groups (ENG's). */
const categories = new Map<string, string>(engWorkflow.statuses.map((s) => [s.id, s.category]));
const categoryOf = (statusId: string) => categories.get(statusId);

// "now" is 14 days after the US DST switch, so -P14D lands on the boundary.
const NOW = Date.parse('2026-03-22T07:00:00.000Z');
const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Berlin',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
];

// ── Value pools: rows and filters draw from the same values so filters hit ───

/** Titles are 1–255 characters (the `issues_title_check`). */
const TEXTS = [
  'Bug',
  'bug',
  'BUG fix',
  'İstanbul',
  'istanbul',
  'ΟΔΟΣ',
  'οδος',
  'Straße',
  'STRASSE',
  '100% _done_ \\o/',
  'naïve',
  'nai\u0308ve',
  '😀 emoji',
  'ǅungla',
];
const CONTAINS = [
  '',
  'bug',
  'BUG',
  'İ',
  'i\u0307',
  'ος',
  'σ',
  'ss',
  'ß',
  '%',
  '_',
  '\\',
  'e\u0308',
  '😀',
  'ǆ',
];
const INSTANTS = [
  '2026-03-08T06:59:59.999Z',
  '2026-03-08T07:00:00.000Z',
  '2026-03-08T07:00:00.001Z',
  '2026-03-29T00:59:59.999Z',
  '2026-03-29T01:00:00.000Z',
  '2026-03-22T07:00:00.000Z',
  '2028-02-29T12:00:00.000Z',
  '1999-12-31T23:59:59.999Z',
];
const INSTANT_FILTER_VALUES = [
  ...INSTANTS,
  '2026-03-08T01:59:59.999-05:00',
  '2026-03-08T02:00:00+00:00',
  '-P14D',
  '-PT1M',
  'P1W',
  '-P1DT2H',
  'P0D',
];
const DAYS = [
  '2026-02-28',
  '2026-03-07',
  '2026-03-08',
  '2026-03-09',
  '2026-03-21',
  '2026-03-22',
  '2026-03-23',
  '2028-02-29',
  '2026-12-31',
];
const DAY_FILTER_VALUES = [...DAYS, '-P1D', 'P0D', 'P1D', '-P2W', 'P1W'];
const PRIORITIES = [0, 1, 2, 3, 4];
const ESTIMATES = [0, 1, 2, 3, 5, 8, 21];
const NUMBER_FILTER_VALUES = [...PRIORITIES, ...ESTIMATES, -0, 2.5, -1, 0.1, 2 ** 53, 12, 25];
const ISSUE_ENUM_VALUES: readonly string[] =
  ISSUE_FILTER_FIELDS['status.category'].type === 'enum'
    ? ISSUE_FILTER_FIELDS['status.category'].values
    : [];

interface Seed {
  readonly secret: boolean;
  readonly title: string;
  readonly status: number;
  readonly priority: number;
  readonly assigneeId: string | null;
  readonly creatorId: string;
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly canceledAt: string | null;
  readonly archivedAt: string | null;
}

const orNull = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null, freq: 4 });
const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);

const seedArb: fc.Arbitrary<Seed> = fc.record({
  // A SEC issue now and then: the actor never holds it, but compiled filters must agree on it.
  secret: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  title: fc.oneof(
    pick(TEXTS),
    fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 6 })
      .filter((s) => !s.includes('\u0000') && s.trim().length > 0),
  ),
  status: fc.nat(),
  priority: pick(PRIORITIES),
  assigneeId: orNull(pick(USERS)),
  creatorId: pick(USERS),
  labelIds: fc.uniqueArray(pick(LABELS), { maxLength: 3 }),
  estimate: orNull(pick(ESTIMATES)),
  dueDate: orNull(pick(DAYS)),
  createdAt: pick(INSTANTS),
  updatedAt: pick(INSTANTS),
  startedAt: orNull(pick(INSTANTS)),
  completedAt: orNull(pick(INSTANTS)),
  canceledAt: orNull(pick(INSTANTS)),
  archivedAt: orNull(pick(INSTANTS)),
});

const seedsArb = fc.array(seedArb, { maxLength: 25 });

/** The ids a reference filter names: those of its own kind, so most filters hit some rows. */
const REF_POOLS: Partial<Record<FieldName, readonly string[]>> = {
  team: [ENG, SEC],
  status: [...engWorkflow.statuses, ...secWorkflow.statuses].map((s) => s.id),
  assignee: USERS,
  creator: USERS,
  labels: LABELS,
};

function scalarArb(field: FieldName, op: FilterOp): fc.Arbitrary<string | number> {
  const def = ISSUE_FILTER_FIELDS[field];
  switch (def.type) {
    case 'text':
      return op === 'contains' ? pick(CONTAINS) : pick(TEXTS);
    case 'enum':
      return pick(def.values);
    case 'number':
      return pick(NUMBER_FILTER_VALUES);
    case 'instant':
      return pick(INSTANT_FILTER_VALUES);
    case 'day':
      return pick(DAY_FILTER_VALUES);
    case 'ref':
    case 'refs':
      return fc.oneof(
        pick(REF_POOLS[field] ?? []),
        fc.constant('me'),
        fc.constant(USERS[1].toUpperCase()),
      );
  }
}

const conditionArb: fc.Arbitrary<Filter> = pick(FIELD_NAMES).chain((field) =>
  pick(OPS_BY_TYPE[ISSUE_FILTER_FIELDS[field].type]).chain((op): fc.Arbitrary<Filter> => {
    if (op === 'exists') return fc.boolean().map((value) => ({ field, op, value }));
    if (op === 'in' || op === 'nin') {
      return fc
        .array(scalarArb(field, op), { maxLength: 4 })
        .map((vs) => ({ field, op, value: vs.filter((v) => typeof v !== 'boolean') }));
    }
    return scalarArb(field, op).map((value) => ({ field, op, value }));
  }),
);

const filterArb: fc.Arbitrary<Filter> = fc.letrec<{ node: Filter }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    conditionArb,
    fc.array(tie('node'), { maxLength: 3 }).map((and) => ({ and })),
    fc.array(tie('node'), { maxLength: 3 }).map((or) => ({ or })),
  ),
})).node;

const ctxArb: fc.Arbitrary<FilterContext> = pick(ZONES).map((timeZone) => ({
  now: NOW,
  timeZone,
  me: USERS[0],
}));

// ── Database plumbing ────────────────────────────────────────────────────────

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const [n, id] of USERS.entries()) {
      await repo.insert('User', {
        id,
        email: `user${String(n)}@example.com`,
        name: `user${String(n)}`,
        displayName: `User ${String(n)}`,
        role: 'member',
        syncGroups: [],
      });
    }
    for (const [id, key, workflow, isPrivate] of [
      [ENG, 'ENG', engWorkflow, false],
      [SEC, 'SEC', secWorkflow, true],
    ] as const) {
      await repo.insert('Team', {
        id,
        key,
        name: key,
        private: isPrivate,
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
  // The statuses the replica holds are those the database gives the actor's groups.
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id::text FROM workflow_statuses WHERE sync_groups && $1::text[]',
    [SCOPE.groups],
  );
  expect(rows.map((r) => r.id).sort()).toEqual([...categories.keys()].sort());
});
afterAll(async () => {
  await db.drop();
});

/** Raw rows (tests may write SQL): the transaction is rolled back, so `sync_log` never sees them. */
async function insertIssues(client: pg.PoolClient, seeds: readonly Seed[]): Promise<void> {
  for (const [n, s] of seeds.entries()) {
    const teamId = s.secret ? SEC : ENG;
    const statuses = (s.secret ? secWorkflow : engWorkflow).statuses;
    const status = statuses[s.status % statuses.length];
    if (status === undefined) throw new Error('A team without statuses');
    await client.query(
      `INSERT INTO issues (id, team_id, number, title, status_id, priority, assignee_id, label_ids,
         estimate, due_date, sort_order, creator_id, started_at, completed_at, canceled_at,
         archived_at, sync_groups, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        uuidv7(),
        teamId,
        n + 1,
        s.title,
        status.id,
        s.priority,
        s.assigneeId,
        s.labelIds,
        s.estimate,
        s.dueDate,
        `a${String(n)}`,
        s.creatorId,
        s.startedAt,
        s.completedAt,
        s.canceledAt,
        s.archivedAt,
        [`team:${teamId}`],
        s.createdAt,
        s.updatedAt,
      ],
    );
  }
}

/**
 * The rows as a replica holds them: the bootstrap's select and `clientRow`, sent as NDJSON and
 * parsed with the `Issue` row schema. Archived rows are read too (a replica gets them from
 * `issue.list` with `includeArchived`), and SEC's (the comparison runs on every row).
 */
async function readRows(client: pg.PoolClient) {
  const model = issueModel;
  if (model === undefined) throw new Error('No Issue model');
  const select = selectRows(model);
  const where = rowsWhere(model);
  expect(select.endsWith(where)).toBe(true);
  const { rows } = await client.query<Record<string, unknown>>(
    `${select.slice(0, -where.length)} sync_groups && $1::text[] ORDER BY number`,
    [[`team:${ENG}`, `team:${SEC}`]],
  );
  const visible = new Set(SCOPE.groups);
  return rows.map((row) => {
    const sent = encodeNdjsonLine(clientRow(model, row, row[GROUPS_ALIAS], visible));
    const parsed: unknown = JSON.parse(sent);
    return Issue.rowSchema.parse(parsed);
  });
}

async function sqlNumbers(
  client: pg.PoolClient,
  filter: Filter,
  ctx: FilterContext,
): Promise<number[]> {
  const where = compileFilter(filter, issueListModel.filter, ctx, SCOPE);
  const query = dialect.sqlToQuery(sql`SELECT number FROM issues WHERE ${where} ORDER BY number`);
  const { rows } = await client.query<{ number: number }>(query.sql, query.params);
  return rows.map((r) => r.number);
}

type Stored = Awaited<ReturnType<typeof readRows>>[number];
function clientNumbers(rows: readonly Stored[], filter: Filter, ctx: FilterContext): number[] {
  return filterIssues(rows, filter, ctx, categoryOf).map((r) => r.number ?? -1);
}

/** Run `fn` against a set of issues that disappears afterwards. */
async function withIssues<T>(
  seeds: readonly Seed[],
  fn: (client: pg.PoolClient, stored: Stored[]) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await insertIssues(client, seeds);
    return await fn(client, await readRows(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Issue filter conformance (AC-11)', () => {
  it('gives identical results on the client and in SQL for 1,500 generated Issue filters', async () => {
    let filters = 0;
    let selective = 0; // matched some rows but not all: guards against a vacuous test
    const fieldsHit = new Set<string>();
    const visit = (f: Filter) => {
      if ('and' in f) f.and.forEach(visit);
      else if ('or' in f) f.or.forEach(visit);
      else fieldsHit.add(f.field);
    };
    await fc.assert(
      fc.asyncProperty(
        seedsArb,
        fc.array(filterArb, { minLength: 5, maxLength: 5 }),
        ctxArb,
        (seeds, fs, ctx) =>
          withIssues(seeds, async (client, stored) => {
            expect(stored).toHaveLength(seeds.length);
            for (const f of fs) {
              const expected = clientNumbers(stored, f, ctx);
              expect(await sqlNumbers(client, f, ctx), JSON.stringify({ filter: f, ctx })).toEqual(
                expected,
              );
              visit(f);
              filters += 1;
              if (expected.length > 0 && expected.length < stored.length) selective += 1;
            }
          }),
      ),
      { seed: 20261116, numRuns: 300 },
    );
    expect(filters).toBeGreaterThanOrEqual(1_500);
    expect(selective / filters).toBeGreaterThan(0.25);
    expect([...fieldsHit].sort()).toEqual([...FIELD_NAMES].sort());
  });

  it('agrees on hand-picked edge cases of the Issue fields', async () => {
    const base: Seed = {
      secret: false,
      title: 'İstanbul',
      status: 0,
      priority: 0,
      assigneeId: null,
      creatorId: USERS[0],
      labelIds: [],
      estimate: null,
      dueDate: null,
      createdAt: '2026-03-08T07:00:00.000Z',
      updatedAt: '2026-03-08T07:00:00.000Z',
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
    };
    const seeds: Seed[] = [
      base,
      {
        ...base,
        title: 'ΟΔΟΣ',
        status: 3,
        priority: 4,
        assigneeId: USERS[0],
        labelIds: [LABELS[0], LABELS[3]],
        estimate: 0,
        dueDate: '2028-02-29',
        startedAt: '2026-03-08T06:59:59.999Z',
      },
      { ...base, secret: true, title: '100% _done_', status: 4, archivedAt: INSTANTS[0] ?? null },
    ];
    const cases: Filter[] = [
      { and: [] },
      { or: [] },
      { field: 'title', op: 'contains', value: 'i\u0307' },
      { field: 'title', op: 'contains', value: 'ος' },
      { field: 'title', op: 'contains', value: '%' },
      { field: 'estimate', op: 'eq', value: -0 },
      { field: 'estimate', op: 'exists', value: false },
      { field: 'assignee', op: 'eq', value: 'me' },
      { field: 'assignee', op: 'neq', value: 'me' }, // includes no assignee
      { field: 'labels', op: 'eq', value: 'me' }, // a label id equal to the user's id
      { field: 'labels', op: 'nin', value: [LABELS[0].toUpperCase()] },
      { field: 'labels', op: 'exists', value: false },
      { field: 'team', op: 'eq', value: SEC },
      { field: 'createdAt', op: 'gte', value: '-P14D' },
      { field: 'dueDate', op: 'eq', value: '2028-02-29' },
      { field: 'archivedAt', op: 'exists', value: true },
      ...ISSUE_ENUM_VALUES.map((value): Filter => ({ field: 'status.category', op: 'eq', value })),
      { field: 'status.category', op: 'exists', value: false }, // SEC's status → null
    ];
    await withIssues(seeds, async (client, stored) => {
      for (const timeZone of ZONES) {
        const ctx = { now: NOW, timeZone, me: USERS[0] };
        for (const f of cases) {
          expect(await sqlNumbers(client, f, ctx), JSON.stringify({ f, timeZone })).toEqual(
            clientNumbers(stored, f, ctx),
          );
        }
      }
    });
  });

  it('never matches an issue through a SEC status the actor cannot see (private-team leak)', async () => {
    const canceled = secWorkflow.statuses.findIndex((s) => s.category === 'canceled');
    expect(canceled).toBeGreaterThanOrEqual(0);
    const seed: Seed = {
      secret: true,
      title: 'x',
      status: canceled,
      priority: 0,
      assigneeId: null,
      creatorId: USERS[1],
      labelIds: [],
      estimate: null,
      dueDate: null,
      createdAt: INSTANTS[0] ?? '',
      updatedAt: INSTANTS[0] ?? '',
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
    };
    const ctx = { now: NOW, timeZone: 'UTC', me: USERS[0] };
    await withIssues([seed], async (client, stored) => {
      const probes: [Filter, number[]][] = [
        [{ field: 'status.category', op: 'eq', value: 'canceled' }, []],
        [{ field: 'status.category', op: 'in', value: ['canceled'] }, []],
        [{ field: 'status.category', op: 'exists', value: true }, []],
        [{ field: 'status.category', op: 'neq', value: 'canceled' }, [1]],
      ];
      for (const [f, expected] of probes) {
        expect(await sqlNumbers(client, f, ctx), JSON.stringify(f)).toEqual(expected);
        expect(clientNumbers(stored, f, ctx), JSON.stringify(f)).toEqual(expected);
      }
    });
  });
});
