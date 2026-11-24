/**
 * SPEC-011 AC-11 (PLAN-011 S8), the client half: every field of `ISSUE_FILTER_FIELDS` with every
 * operator its type allows, evaluated on replica Issue rows. Each field is checked on three rows
 * that differ only in that field (two values and a missing one), so a field read from the wrong
 * column fails. The server half, against Postgres through the real codec, is
 * `apps/server/test/issue-filter-conformance.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  FilterError,
  OPS_BY_TYPE,
  type FieldType,
  type Filter,
  type FilterOp,
  type FilterValue,
} from './filter/index.js';
import { ISSUE_FILTER_FIELDS } from './issue.js';
import { filterIssues, type IssueFilterField, type IssueFilterRow } from './issue-filter.js';

const U1 = '0190f0c0-0000-7000-8000-000000000001';
const U2 = '0190f0c0-0000-7000-8000-000000000002';
const U3 = '0190f0c0-0000-7000-8000-000000000003';
const STARTED = '0190f0c0-0000-7000-8000-0000000005a1';
const COMPLETED = '0190f0c0-0000-7000-8000-0000000005a2';
/** A status the replica doesn't hold: no category, like a status the actor can't see. */
const UNKNOWN_STATUS = '0190f0c0-0000-7000-8000-0000000005ff';
const CATEGORIES = new Map([
  [STARTED, 'started'],
  [COMPLETED, 'completed'],
]);
const categoryOf = (statusId: string) => CATEGORIES.get(statusId);

/** 2026-11-16 12:00 UTC; "me" is U2. */
const ctx = { now: Date.parse('2026-11-16T12:00:00.000Z'), timeZone: 'UTC', me: U2 };

const BASE: IssueFilterRow = {
  teamId: U3,
  number: 7,
  title: 'Same',
  statusId: STARTED,
  priority: 2,
  assigneeId: U3,
  creatorId: U3,
  labelIds: [U3],
  estimate: 2,
  dueDate: '2026-12-01',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  startedAt: '2026-11-01T00:00:00.000Z',
  completedAt: '2026-11-01T00:00:00.000Z',
  canceledAt: '2026-11-01T00:00:00.000Z',
  archivedAt: '2026-11-01T00:00:00.000Z',
};

/** How a test row holds a value of each field: written here, apart from the evaluator's own map. */
const SET: {
  readonly [F in IssueFilterField]: (value: unknown) => Partial<IssueFilterRow>;
} = {
  team: (teamId) => ({ teamId }),
  number: (number) => ({ number }),
  title: (title) => ({ title }),
  status: (statusId) => ({ statusId }),
  'status.category': (category) => ({
    statusId:
      [...CATEGORIES].find(([, name]) => name === category)?.[0] ??
      (category === null ? UNKNOWN_STATUS : category),
  }),
  priority: (priority) => ({ priority }),
  assignee: (assigneeId) => ({ assigneeId }),
  creator: (creatorId) => ({ creatorId }),
  labels: (labelIds) => ({ labelIds }),
  estimate: (estimate) => ({ estimate }),
  dueDate: (dueDate) => ({ dueDate }),
  createdAt: (createdAt) => ({ createdAt }),
  updatedAt: (updatedAt) => ({ updatedAt }),
  startedAt: (startedAt) => ({ startedAt }),
  completedAt: (completedAt) => ({ completedAt }),
  canceledAt: (canceledAt) => ({ canceledAt }),
  archivedAt: (archivedAt) => ({ archivedAt }),
};

type Expected = readonly ('a' | 'b' | 'c')[];
interface TypeCase {
  /** Values of rows a and b; row c holds none (null, or no labels). */
  readonly a: unknown;
  readonly b: unknown;
  readonly c: unknown;
  readonly cases: readonly (readonly [FilterOp, FilterValue, Expected])[];
}

const EXISTS = [
  ['exists', true, ['a', 'b']],
  ['exists', false, ['c']],
] as const;

const BY_TYPE: Partial<Record<FieldType, TypeCase>> = {
  ref: {
    a: U1,
    b: U2,
    c: null,
    cases: [
      ['eq', U1, ['a']],
      ['eq', 'me', ['b']],
      ['eq', U1.toUpperCase(), ['a']],
      ['neq', U1, ['b', 'c']],
      ['in', [U1, U3], ['a']],
      ['in', [], []],
      ['nin', [U1], ['b', 'c']],
      ['nin', [], ['a', 'b', 'c']],
      ...EXISTS,
    ],
  },
  refs: {
    a: [U1, U2],
    b: [U2],
    c: [],
    cases: [
      ['eq', U1, ['a']],
      ['eq', 'me', ['a', 'b']],
      ['neq', U1, ['b', 'c']],
      ['in', [U1, U3], ['a']],
      ['nin', [U2], ['c']],
      ...EXISTS,
    ],
  },
  number: {
    a: 1,
    b: 3,
    c: null,
    cases: [
      ['eq', 1, ['a']],
      ['neq', 1, ['b', 'c']],
      ['in', [3, 4], ['b']],
      ['nin', [3], ['a', 'c']],
      ['lt', 3, ['a']],
      ['lte', 3, ['a', 'b']],
      ['gt', 1, ['b']],
      ['gte', 1, ['a', 'b']],
      ...EXISTS,
    ],
  },
  text: {
    a: 'Fix Login on Safari',
    b: 'Add export',
    c: null,
    cases: [
      ['eq', 'Fix Login on Safari', ['a']],
      ['eq', 'fix login on safari', []],
      ['neq', 'Add export', ['a', 'c']],
      ['in', ['Add export', 'Other'], ['b']],
      ['nin', ['Add export'], ['a', 'c']],
      ['contains', 'LOGIN', ['a']],
      ['contains', '', ['a', 'b']],
      ...EXISTS,
    ],
  },
  enum: {
    a: 'started',
    b: 'completed',
    c: null,
    cases: [
      ['eq', 'started', ['a']],
      ['neq', 'started', ['b', 'c']],
      ['in', ['completed', 'canceled'], ['b']],
      ['nin', ['completed'], ['a', 'c']],
      ...EXISTS,
    ],
  },
  day: {
    a: '2026-11-10',
    b: '2026-11-20',
    c: null,
    cases: [
      ['eq', '2026-11-10', ['a']],
      // Six days before today (2026-11-16 in UTC).
      ['eq', '-P6D', ['a']],
      ['neq', '2026-11-10', ['b', 'c']],
      ['lt', '2026-11-20', ['a']],
      ['lte', '2026-11-20', ['a', 'b']],
      ['gt', '2026-11-10', ['b']],
      ['gte', 'P0D', ['b']],
      ...EXISTS,
    ],
  },
  instant: {
    a: '2026-11-10T10:00:00.000Z',
    b: '2026-11-20T10:00:00.000Z',
    c: null,
    cases: [
      ['lt', '2026-11-20T10:00:00.000Z', ['a']],
      ['lte', '2026-11-20T10:00:00.000Z', ['a', 'b']],
      ['gt', '2026-11-10T10:00:00.000Z', ['b']],
      ['gte', '2026-11-10T11:00:00+01:00', ['a', 'b']],
      // A week before now, and a day after it.
      ['gte', '-P7D', ['a', 'b']],
      ['lt', 'P1D', ['a']],
      ...EXISTS,
    ],
  },
};

const isField = (name: string): name is IssueFilterField => Object.hasOwn(SET, name);
const FIELDS = Object.keys(ISSUE_FILTER_FIELDS).filter(isField);

describe('the Issue filter on the client (AC-11)', () => {
  it('covers every field of ISSUE_FILTER_FIELDS, and every operator its type allows', () => {
    expect(Object.keys(SET).sort()).toEqual(Object.keys(ISSUE_FILTER_FIELDS).sort());
    for (const field of FIELDS) {
      const type = ISSUE_FILTER_FIELDS[field].type;
      const covered = new Set(BY_TYPE[type]?.cases.map(([op]) => op));
      expect([...covered].sort(), `${field} (${type})`).toEqual([...OPS_BY_TYPE[type]].sort());
    }
  });

  describe.each(FIELDS)('%s', (field) => {
    const type = ISSUE_FILTER_FIELDS[field].type;
    const spec = BY_TYPE[type];
    const rows = (['a', 'b', 'c'] as const).map((name) => ({
      ...BASE,
      ...SET[field](spec?.[name]),
      name,
    }));
    it.each(spec?.cases ?? [])('%s %j matches %j', (op, value, expected) => {
      const filter: Filter = { field, op, value };
      expect(filterIssues(rows, filter, ctx, categoryOf).map((r) => r.name)).toEqual(expected);
    });
  });

  it('combines conditions with and and or', () => {
    const rows = [
      { ...BASE, name: 'a', priority: 1, labelIds: [U1] },
      { ...BASE, name: 'b', priority: 1, labelIds: [] },
      { ...BASE, name: 'c', priority: 3, labelIds: [U1] },
    ];
    const urgentWithLabel: Filter = {
      and: [
        { field: 'priority', op: 'eq', value: 1 },
        { field: 'labels', op: 'eq', value: U1 },
      ],
    };
    expect(filterIssues(rows, urgentWithLabel, ctx, categoryOf).map((r) => r.name)).toEqual(['a']);
    const either: Filter = { or: [urgentWithLabel, { field: 'priority', op: 'gt', value: 2 }] };
    expect(filterIssues(rows, either, ctx, categoryOf).map((r) => r.name)).toEqual(['a', 'c']);
  });

  it('refuses what the server refuses: an unknown field, an operator the type lacks', () => {
    const refused: Filter[] = [
      { field: 'description', op: 'contains', value: 'x' },
      { field: 'title', op: 'lt', value: 'x' },
      { field: 'labels', op: 'contains', value: U1 },
      { field: 'status.category', op: 'eq', value: 'nope' },
    ];
    for (const filter of refused) {
      expect(() => filterIssues([BASE], filter, ctx, categoryOf), JSON.stringify(filter)).toThrow(
        FilterError,
      );
    }
  });
});
