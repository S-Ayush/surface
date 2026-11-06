// SPEC-003 AC-6: the client evaluator and the SQL compiler return identical
// results for generated filters over edge-value rows (nulls, empty sets,
// Unicode case folding, -0 and float rounding, DST and leap days, orphan joins).
import {
  defineFilterFields,
  matches,
  OPS_BY_TYPE,
  resolveFilter,
  type Filter,
  type FilterContext,
  type FilterOp,
} from '@surface/domain';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileFilter,
  defineFilterModel,
  type VisibilityScope,
} from '../src/executor/filter-sql.js';
import { createTestDatabase, type TestDatabase } from './db.js';

// ── Fixture model ────────────────────────────────────────────────────────────

const FIELDS = defineFilterFields({
  title: { type: 'text' },
  kind: { type: 'enum', values: ['bug', 'feature', 'chore'] },
  priority: { type: 'number' },
  estimate: { type: 'number' },
  done: { type: 'boolean' },
  createdAt: { type: 'instant' },
  dueOn: { type: 'day' },
  ownerId: { type: 'ref' },
  labelIds: { type: 'refs' },
  'status.category': { type: 'enum', values: ['backlog', 'started', 'completed', 'canceled'] },
});
type FieldName = keyof typeof FIELDS;

// The actor sees workspace-wide rows and team A's, not team "secret".
const SCOPE: VisibilityScope = { groups: ['workspace', 'team:a'] };

const MODEL = defineFilterModel({
  fields: FIELDS,
  columns: (scope) => ({
    title: sql`f.title`,
    kind: sql`f.kind`,
    priority: sql`f.priority`,
    estimate: sql`f.estimate`,
    done: sql`f.done`,
    createdAt: sql`f.created_at`,
    dueOn: sql`f.due_on`,
    ownerId: sql`f.owner_id`,
    labelIds: sql`f.label_ids`,
    'status.category': sql`(SELECT s.category FROM filter_fixture_status s
      WHERE s.id = f.status_id AND s.sync_groups && ${sql.param([...scope.groups])}::text[])`,
  }),
});

const SCHEMA = `
  CREATE TABLE filter_fixture_status (
    id uuid PRIMARY KEY, category text NOT NULL, sync_groups text[] NOT NULL
  );
  CREATE TABLE filter_fixture (
    id         integer PRIMARY KEY,
    title      text,
    kind       text,
    priority   integer,
    estimate   double precision,
    done       boolean,
    created_at timestamptz(3),
    due_on     date,
    owner_id   uuid,
    label_ids  uuid[],
    status_id  uuid
  );`;

const U = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-00000000000a',
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
] as const;
const STATUSES = [
  { id: '10000000-0000-4000-8000-000000000001', category: 'backlog', groups: ['workspace'] },
  { id: '10000000-0000-4000-8000-000000000002', category: 'started', groups: ['team:a'] },
  { id: '10000000-0000-4000-8000-000000000003', category: 'completed', groups: ['team:a'] },
  // Invisible to the actor: the client replica never receives it.
  { id: '10000000-0000-4000-8000-000000000004', category: 'canceled', groups: ['team:secret'] },
] as const;
const HIDDEN_STATUS = STATUSES[3].id;
const ORPHAN_STATUS = '10000000-0000-4000-8000-0000000000ff';

// "now" is 14 days after the US DST switch, so -P14D lands on the boundary.
const NOW = Date.parse('2026-03-22T07:00:00.000Z');
const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Berlin',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
];

// ── Value pools: rows and filters draw from the same values so filters hit ──

const TEXTS = [
  '',
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
const ESTIMATES = [0, -0, 0.1, 0.2, 0.30000000000000004, 1e-7, -1.5, 2 ** 53];
const NUMBER_FILTER_VALUES = [...PRIORITIES, ...ESTIMATES, 0.3, 2.5, -1];

interface Row {
  id: number;
  title: string | null;
  kind: string | null;
  priority: number | null;
  estimate: number | null;
  done: boolean | null;
  createdAt: string | null;
  dueOn: string | null;
  ownerId: string | null;
  labelIds: string[] | null;
  statusId: string | null;
}

const orNull = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null, freq: 4 });
const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);

const rowArb = (id: number): fc.Arbitrary<Row> =>
  fc.record({
    id: fc.constant(id),
    title: orNull(
      fc.oneof(
        pick(TEXTS),
        fc.string({ unit: 'grapheme', maxLength: 6 }).filter((s) => !s.includes('\u0000')),
      ),
    ),
    kind: orNull(pick(FIELDS.kind.values)),
    priority: orNull(pick(PRIORITIES)),
    estimate: orNull(pick(ESTIMATES)),
    done: orNull(fc.boolean()),
    createdAt: orNull(pick(INSTANTS)),
    dueOn: orNull(pick(DAYS)),
    ownerId: orNull(pick(U)),
    labelIds: orNull(fc.uniqueArray(pick(U), { maxLength: 3 })),
    statusId: orNull(pick([...STATUSES.map((s) => s.id), ORPHAN_STATUS])),
  });

const rowsArb = fc
  .integer({ min: 0, max: 25 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => rowArb(i + 1))));

function scalarArb(field: FieldName, op: FilterOp): fc.Arbitrary<string | number | boolean> {
  const def = FIELDS[field];
  switch (def.type) {
    case 'text':
      return op === 'contains' ? pick(CONTAINS) : pick(TEXTS);
    case 'enum':
      return pick(def.values);
    case 'number':
      return pick(NUMBER_FILTER_VALUES);
    case 'boolean':
      return fc.boolean();
    case 'instant':
      return pick(INSTANT_FILTER_VALUES);
    case 'day':
      return pick(DAY_FILTER_VALUES);
    case 'ref':
    case 'refs':
      return fc.oneof(pick(U), fc.constant('me'), fc.constant(U[2].toUpperCase()));
  }
}

const conditionArb: fc.Arbitrary<Filter> = pick(Object.keys(FIELDS) as FieldName[]).chain((field) =>
  pick(OPS_BY_TYPE[FIELDS[field].type]).chain((op): fc.Arbitrary<Filter> => {
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
  me: U[0],
}));

// ── Database plumbing ────────────────────────────────────────────────────────

let db: TestDatabase;
const dialect = new PgDialect();

beforeAll(async () => {
  db = await createTestDatabase({ migrated: false });
  await db.pool.query(SCHEMA);
  for (const s of STATUSES) {
    await db.pool.query('INSERT INTO filter_fixture_status VALUES ($1, $2, $3)', [
      s.id,
      s.category,
      s.groups,
    ]);
  }
});
afterAll(async () => {
  await db.drop();
});

async function insertRows(client: pg.PoolClient, rows: readonly Row[]): Promise<void> {
  for (const r of rows) {
    await client.query(
      `INSERT INTO filter_fixture VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        r.id,
        r.title,
        r.kind,
        r.priority,
        r.estimate,
        r.done,
        r.createdAt,
        r.dueOn,
        r.ownerId,
        r.labelIds,
        r.statusId,
      ],
    );
  }
}

/** Rows as the database returns them: the client replica holds server data. */
async function readRows(client: pg.PoolClient): Promise<Row[]> {
  const { rows } = await client.query<Row>(`
    SELECT id, title, kind, priority, estimate, done,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
           due_on::text AS "dueOn", owner_id::text AS "ownerId",
           label_ids::text[] AS "labelIds", status_id::text AS "statusId"
      FROM filter_fixture ORDER BY id`);
  return rows;
}

// The replica: only statuses in the actor's sync groups.
const categoryOf = new Map<string, string>(
  STATUSES.filter((s) => s.groups.some((g) => SCOPE.groups.includes(g))).map((s) => [
    s.id,
    s.category,
  ]),
);
const GETTERS: { readonly [K in FieldName]: (row: Row) => unknown } = {
  title: (r) => r.title,
  kind: (r) => r.kind,
  priority: (r) => r.priority,
  estimate: (r) => r.estimate,
  done: (r) => r.done,
  createdAt: (r) => r.createdAt,
  dueOn: (r) => r.dueOn,
  ownerId: (r) => r.ownerId,
  labelIds: (r) => r.labelIds,
  'status.category': (r) => (r.statusId === null ? null : (categoryOf.get(r.statusId) ?? null)),
};
const isFieldName = (name: string): name is FieldName => name in GETTERS;
const get = (row: Row, field: string) => (isFieldName(field) ? GETTERS[field](row) : undefined);

async function sqlIds(
  client: pg.PoolClient,
  filter: Filter,
  ctx: FilterContext,
): Promise<number[]> {
  const where = compileFilter(filter, MODEL, ctx, SCOPE);
  const query = dialect.sqlToQuery(
    sql`SELECT f.id FROM filter_fixture f WHERE ${where} ORDER BY f.id`,
  );
  const { rows } = await client.query<{ id: number }>(query.sql, query.params);
  return rows.map((r) => r.id);
}

function clientIds(rows: readonly Row[], filter: Filter, ctx: FilterContext): number[] {
  const resolved = resolveFilter(filter, FIELDS, ctx);
  return rows.filter((r) => matches(resolved, r, get)).map((r) => r.id);
}

/** Run `fn` against a set of rows that disappears afterwards. */
async function withRows<T>(
  rows: readonly Row[],
  fn: (client: pg.PoolClient, stored: Row[]) => Promise<T>,
) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await insertRows(client, rows);
    return await fn(client, await readRows(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('filter conformance (AC-6)', () => {
  it('gives identical results on the client and in SQL for 1,500 generated filters', async () => {
    let filters = 0;
    let selective = 0; // matched some rows but not all: guards against a vacuous test
    await fc.assert(
      fc.asyncProperty(
        rowsArb,
        fc.array(filterArb, { minLength: 5, maxLength: 5 }),
        ctxArb,
        (rows, fs, ctx) =>
          withRows(rows, async (client, stored) => {
            for (const f of fs) {
              const expected = clientIds(stored, f, ctx);
              expect(await sqlIds(client, f, ctx), JSON.stringify({ filter: f, ctx })).toEqual(
                expected,
              );
              filters += 1;
              if (expected.length > 0 && expected.length < stored.length) selective += 1;
            }
          }),
      ),
      { seed: 20261106, numRuns: 300 },
    );
    expect(filters).toBeGreaterThanOrEqual(1_500);
    expect(selective / filters).toBeGreaterThan(0.25);
  });

  it('agrees on hand-picked edge cases', async () => {
    const rows: Row[] = [
      {
        id: 1,
        title: 'İstanbul',
        kind: 'bug',
        priority: 0,
        estimate: -0,
        done: false,
        createdAt: '2026-03-08T07:00:00.000Z',
        dueOn: '2028-02-29',
        ownerId: U[0],
        labelIds: [],
        statusId: ORPHAN_STATUS,
      },
      {
        id: 2,
        title: 'ΟΔΟΣ',
        kind: null,
        priority: null,
        estimate: 0.30000000000000004,
        done: null,
        createdAt: null,
        dueOn: null,
        ownerId: null,
        labelIds: null,
        statusId: null,
      },
      {
        id: 3,
        title: '100% _done_',
        kind: 'chore',
        priority: 4,
        estimate: 0.1,
        done: true,
        createdAt: '2026-03-08T06:59:59.999Z',
        dueOn: '2026-03-21',
        ownerId: U[1],
        labelIds: [U[0], U[2]],
        statusId: STATUSES[1].id,
      },
    ];
    const cases: Filter[] = [
      { and: [] },
      { or: [] },
      { field: 'title', op: 'contains', value: 'i\u0307' }, // İ lowercases to i + combining dot
      { field: 'title', op: 'contains', value: 'ος' }, // final sigma
      { field: 'title', op: 'contains', value: '%' },
      { field: 'title', op: 'contains', value: '' },
      { field: 'estimate', op: 'eq', value: 0 }, // matches -0
      { field: 'estimate', op: 'eq', value: 0.3 }, // 0.1 + 0.2 is not 0.3
      { field: 'kind', op: 'neq', value: 'bug' }, // includes null
      { field: 'kind', op: 'nin', value: [] },
      { field: 'kind', op: 'in', value: [] },
      { field: 'labelIds', op: 'nin', value: [U[2].toUpperCase()] },
      { field: 'labelIds', op: 'exists', value: false }, // null and empty
      { field: 'ownerId', op: 'eq', value: 'me' },
      { field: 'createdAt', op: 'gte', value: '-P14D' }, // exactly the DST boundary
      { field: 'dueOn', op: 'eq', value: '-P1D' }, // yesterday, in the context zone
      { field: 'status.category', op: 'neq', value: 'started' }, // orphan status → null
      { field: 'createdAt', op: 'gte', value: '0001-01-01T00:00:00Z' }, // range bounds reach SQL
      { field: 'createdAt', op: 'lte', value: '9999-12-31T23:59:59.999Z' },
    ];
    await withRows(rows, async (client, stored) => {
      for (const timeZone of ZONES) {
        const ctx = { now: NOW, timeZone, me: U[0] };
        for (const f of cases) {
          expect(await sqlIds(client, f, ctx), JSON.stringify({ f, timeZone })).toEqual(
            clientIds(stored, f, ctx),
          );
        }
      }
    });
  });

  it('never matches through a joined row the actor cannot see (private-team leak)', async () => {
    const rows: Row[] = [
      {
        id: 1,
        title: 'x',
        kind: null,
        priority: null,
        estimate: null,
        done: null,
        createdAt: null,
        dueOn: null,
        ownerId: null,
        labelIds: null,
        statusId: HIDDEN_STATUS,
      },
    ];
    const ctx = { now: NOW, timeZone: 'UTC', me: U[0] };
    await withRows(rows, async (client, stored) => {
      const probes: [Filter, number[]][] = [
        [{ field: 'status.category', op: 'eq', value: 'canceled' }, []],
        [{ field: 'status.category', op: 'in', value: ['canceled'] }, []],
        [{ field: 'status.category', op: 'exists', value: true }, []],
        [{ field: 'status.category', op: 'neq', value: 'canceled' }, [1]],
      ];
      for (const [f, expected] of probes) {
        expect(await sqlIds(client, f, ctx), JSON.stringify(f)).toEqual(expected);
        expect(clientIds(stored, f, ctx), JSON.stringify(f)).toEqual(expected);
      }
    });
  });
});
