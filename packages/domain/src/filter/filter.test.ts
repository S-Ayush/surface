// SPEC-003 §7.4 filter semantics: validation, relative values, evaluation.
// Client/SQL agreement is AC-6 (apps/server/test/filter-conformance.int.test.ts).
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import {
  defineFilterFields,
  FILTER_LIMITS,
  FilterError,
  FilterSchema,
  matches,
  OPS_BY_TYPE,
  parseDuration,
  resolveFilter,
  type Filter,
  type FilterContext,
  type FilterField,
  type FilterOp,
  type FilterValue,
  type ResolvedFilter,
} from './index.js';

const FIELDS = defineFilterFields({
  title: { type: 'text' },
  kind: { type: 'enum', values: ['bug', 'feature'] },
  priority: { type: 'number' },
  done: { type: 'boolean' },
  createdAt: { type: 'instant' },
  dueOn: { type: 'day' },
  assignee: { type: 'ref' },
  labels: { type: 'refs' },
  'status.category': { type: 'enum', values: ['backlog', 'started'] },
});

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-11-06T03:30:00.000Z');
const ctx: FilterContext = { now: NOW, timeZone: 'UTC', me: ME };

const resolve = (f: Filter, c: FilterContext = ctx) => resolveFilter(f, FIELDS, c);
const get = (row: Record<string, unknown>, field: string) => row[field];
const test = (f: Filter, row: Record<string, unknown>, c: FilterContext = ctx) =>
  matches(resolve(f, c), row, get);

function errorOf(fn: () => unknown): FilterError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FilterError) return error;
    throw error;
  }
  throw new Error('expected a FilterError');
}

describe('FilterSchema', () => {
  it('accepts the domain-model example shape', () => {
    const example = {
      and: [
        { field: 'status.category', op: 'in', value: ['unstarted', 'started'] },
        { field: 'assignee', op: 'eq', value: 'me' },
        {
          or: [
            { field: 'priority', op: 'lte', value: 2 },
            { field: 'label', op: 'in', value: ['bug'] },
          ],
        },
        { field: 'updatedAt', op: 'gte', value: '-P14D' },
      ],
    };
    expect(FilterSchema.safeParse(example).success).toBe(true);
  });

  it('rejects unknown keys, operators and non-finite numbers', () => {
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: 1, x: 1 }).success).toBe(false);
    expect(FilterSchema.safeParse({ field: 'a', op: 'like', value: 'x' }).success).toBe(false);
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: Infinity }).success).toBe(false);
    expect(FilterSchema.safeParse({ not: { field: 'a', op: 'eq', value: 1 } }).success).toBe(false);
  });

  it('rejects text Postgres cannot store exactly (NUL, lone surrogates)', () => {
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: 'a\u0000b' }).success).toBe(false);
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: '\uD800x' }).success).toBe(false);
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: '😀' }).success).toBe(true);
  });

  it('rejects deep nesting without overflowing the stack', () => {
    let deep: unknown = { field: 'a', op: 'eq', value: 1 };
    for (let i = 0; i < 100_000; i++) deep = { and: [deep] };
    const result = FilterSchema.safeParse(deep);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      `Filter is nested too deeply: use at most ${FILTER_LIMITS.maxDepth} levels of and/or`,
    );
  });

  it('rejects a node that is both a group and something else, before walking it', () => {
    let deep: unknown = { field: 'a', op: 'eq', value: 1 };
    for (let i = 0; i < 100_000; i++) deep = { or: [deep] };
    const sneaky = FilterSchema.safeParse({ and: [], or: [deep] });
    expect(sneaky.success).toBe(false);
    expect(sneaky.error?.issues[0]?.message).toBe(
      'A filter node must be exactly one of: {"and": [...]}, {"or": [...]}, or a condition (got and + or)',
    );
    const wide = Array.from({ length: 100_000 }, () => ({ field: 'a', op: 'eq', value: 1 }));
    expect(FilterSchema.safeParse({ and: [], or: wide }).success).toBe(false);
    expect(FilterSchema.safeParse({ field: 'a', op: 'eq', value: 1, and: [] }).success).toBe(false);
  });

  it('rejects filters with too many conditions or list values', () => {
    const cond = { field: 'a', op: 'eq', value: 1 };
    const wide = { or: Array.from({ length: FILTER_LIMITS.maxNodes }, () => cond) };
    expect(FilterSchema.safeParse(wide).error?.issues[0]?.message).toMatch(/^Filter is too large/);
    const long = { field: 'a', op: 'in', value: Array.from({ length: 501 }, (_, i) => i) };
    expect(FilterSchema.safeParse(long).success).toBe(false);
  });
});

describe('resolveFilter', () => {
  it('names valid fields when one is unknown', () => {
    const e = errorOf(() => resolve({ and: [{ field: 'nope', op: 'eq', value: 1 }] }));
    expect(e.message).toBe(
      'Unknown filter field "nope". Use one of: title, kind, priority, done, createdAt, dueOn, assignee, labels, status.category.',
    );
    expect(e.path).toEqual(['and', 0, 'field']);
  });

  it('names the operators a field supports', () => {
    expect(errorOf(() => resolve({ field: 'title', op: 'lt', value: 'a' })).message).toBe(
      'Filter field "title" (text) does not support "lt". Use one of: eq, neq, in, nin, contains, exists.',
    );
  });

  it('checks value types and enum values', () => {
    expect(errorOf(() => resolve({ field: 'kind', op: 'eq', value: 'epic' })).message).toBe(
      'Filter field "kind" needs one of: bug, feature.',
    );
    expect(errorOf(() => resolve({ field: 'priority', op: 'eq', value: '1' })).message).toBe(
      'Filter field "priority" needs a number.',
    );
    expect(errorOf(() => resolve({ field: 'kind', op: 'in', value: 'bug' })).message).toBe(
      '"in" takes a list of values, like ["a", "b"].',
    );
    expect(errorOf(() => resolve({ field: 'assignee', op: 'eq', value: 'bob' })).message).toBe(
      'Filter field "assignee" needs an id (uuid) or "me".',
    );
    expect(errorOf(() => resolve({ field: 'done', op: 'exists', value: 'yes' })).path).toEqual([
      'value',
    ]);
  });

  it('resolves "me" to the actor and refuses it without one', () => {
    expect(resolve({ field: 'assignee', op: 'eq', value: 'me' })).toMatchObject({ value: ME });
    expect(
      errorOf(() => resolve({ field: 'labels', op: 'in', value: ['me'] }, { ...ctx, me: null }))
        .message,
    ).toBe('Filter field "labels" needs a specific id: "me" only works for a signed-in user.');
  });

  it('normalises the context user id, and treats a malformed one as a bug', () => {
    const upper = { ...ctx, me: ME.toUpperCase() };
    expect(resolve({ field: 'assignee', op: 'eq', value: 'me' }, upper)).toMatchObject({
      value: ME,
    });
    const broken = () => resolve({ field: 'assignee', op: 'eq', value: 'me' }, { ...ctx, me: 'X' });
    expect(broken).toThrow('FilterContext.me is not a uuid: "X"');
    expect(broken).not.toThrow(FilterError);
  });

  it('lowercases ids so they compare like Postgres uuids', () => {
    expect(resolve({ field: 'assignee', op: 'eq', value: ME.toUpperCase() })).toMatchObject({
      value: ME,
    });
  });

  it('turns durations into exact instants (a day is 24 h, across DST too)', () => {
    expect(resolve({ field: 'createdAt', op: 'gte', value: '-P14D' })).toMatchObject({
      value: NOW - 14 * 86_400_000,
    });
    expect(resolve({ field: 'createdAt', op: 'gte', value: '-P1DT2H30M' })).toMatchObject({
      value: NOW - (26 * 60 + 30) * 60_000,
    });
    expect(
      resolve({ field: 'createdAt', op: 'lt', value: '2026-11-06T09:00:00+05:30' }),
    ).toMatchObject({ value: Date.parse('2026-11-06T03:30:00Z') });
  });

  it('rejects ambiguous or malformed instants', () => {
    for (const value of [
      '2026-11-06T09:00:00',
      '2026-02-30T00:00Z',
      'P1M',
      'P1Y',
      'P',
      'PT',
      'P1DT',
      'yesterday',
    ]) {
      expect(() => resolve({ field: 'createdAt', op: 'gt', value }), value).toThrow(
        'Filter field "createdAt" needs a date-time with a time zone, like 2026-11-06T09:00:00Z, or a duration, like -P14D.',
      );
    }
  });

  it('accepts instants only within years 1–9999 (UTC), which Postgres can take', () => {
    for (const value of ['P999999W', '-P150000W', '0001-01-01T00:00:00+01:00']) {
      expect(() => resolve({ field: 'createdAt', op: 'gt', value }), value).toThrow(
        'Filter field "createdAt" needs a date-time between years 1 and 9999 (UTC).',
      );
    }
    expect(resolve({ field: 'createdAt', op: 'gt', value: '0001-01-01T00:00:00Z' })).toMatchObject({
      value: Date.parse('0001-01-01T00:00:00Z'),
    });
    expect(
      resolve({ field: 'createdAt', op: 'lt', value: '9999-12-31T23:59:59.999Z' }),
    ).toMatchObject({ value: Date.parse('9999-12-31T23:59:59.999Z') });
  });

  it('resolves day durations from today in the context time zone', () => {
    // 03:30 UTC on Nov 6 is still Nov 5 in New York and already Nov 6 in Tokyo.
    const day = (timeZone: string, value: string) =>
      resolve({ field: 'dueOn', op: 'eq', value }, { ...ctx, timeZone });
    expect(day('UTC', 'P0D')).toMatchObject({ value: '2026-11-06' });
    expect(day('America/New_York', 'P0D')).toMatchObject({ value: '2026-11-05' });
    expect(day('Asia/Tokyo', '-P1W')).toMatchObject({ value: '2026-10-30' });
    expect(day('UTC', 'P1D')).toMatchObject({ value: '2026-11-07' });
    expect(
      resolve(
        { field: 'dueOn', op: 'eq', value: 'P1D' },
        { ...ctx, now: Date.parse('2028-02-28T12:00:00Z') },
      ),
    ).toMatchObject({ value: '2028-02-29' });
  });

  it('rejects partial-day durations and invalid dates for day fields, and unknown context zones', () => {
    expect(() => resolve({ field: 'dueOn', op: 'eq', value: '-PT12H' })).toThrow(
      'needs a date like 2026-11-06, or a whole-day duration like -P7D or P2W',
    );
    expect(() => resolve({ field: 'dueOn', op: 'eq', value: '2026-02-29' })).toThrow(
      'needs a date like 2026-11-06',
    );
    // The zone comes from settings, so a bad one is an internal error, not INVALID_INPUT.
    const badZone = () =>
      resolve({ field: 'dueOn', op: 'eq', value: 'P0D' }, { ...ctx, timeZone: 'Mars/Olympus' });
    expect(badZone).toThrow('FilterContext.timeZone is not a known IANA time zone: "Mars/Olympus"');
    expect(badZone).not.toThrow(FilterError);
  });

  it('parses only fixed-length duration units', () => {
    expect(parseDuration('-P2W3DT4H5M')).toEqual({
      sign: -1,
      weeks: 2,
      days: 3,
      hours: 4,
      minutes: 5,
    });
    expect(parseDuration('P1M')).toBeUndefined(); // months vary in length
    expect(parseDuration('PT1S')).toBeUndefined();
  });
});

describe('matches', () => {
  it('treats missing values as false, except for negations', () => {
    const empty = {};
    expect(test({ field: 'kind', op: 'eq', value: 'bug' }, empty)).toBe(false);
    expect(test({ field: 'kind', op: 'neq', value: 'bug' }, empty)).toBe(true);
    expect(test({ field: 'kind', op: 'in', value: ['bug'] }, empty)).toBe(false);
    expect(test({ field: 'kind', op: 'nin', value: ['bug'] }, empty)).toBe(true);
    expect(test({ field: 'priority', op: 'lt', value: 5 }, empty)).toBe(false);
    expect(test({ field: 'title', op: 'contains', value: '' }, empty)).toBe(false);
    expect(test({ field: 'kind', op: 'exists', value: false }, empty)).toBe(true);
  });

  it('treats an empty "and" as true, an empty "or" as false, and empty lists accordingly', () => {
    expect(test({ and: [] }, {})).toBe(true);
    expect(test({ or: [] }, {})).toBe(false);
    expect(test({ field: 'kind', op: 'in', value: [] }, { kind: 'bug' })).toBe(false);
    expect(test({ field: 'kind', op: 'nin', value: [] }, { kind: 'bug' })).toBe(true);
  });

  it('reads id sets as "has" / "has any of" / "has none of"', () => {
    const row = { labels: [ME] };
    expect(test({ field: 'labels', op: 'eq', value: ME }, row)).toBe(true);
    expect(test({ field: 'labels', op: 'neq', value: ME }, row)).toBe(false);
    expect(test({ field: 'labels', op: 'in', value: [OTHER, ME] }, row)).toBe(true);
    expect(test({ field: 'labels', op: 'nin', value: [OTHER] }, row)).toBe(true);
    expect(test({ field: 'labels', op: 'exists', value: false }, { labels: [] })).toBe(true);
    expect(test({ field: 'labels', op: 'exists', value: false }, { labels: null })).toBe(true);
  });

  it('matches text case-insensitively with full Unicode case mapping', () => {
    expect(test({ field: 'title', op: 'contains', value: 'i̇s' }, { title: 'İstanbul' })).toBe(true);
    expect(test({ field: 'title', op: 'contains', value: 'BUG' }, { title: 'a bug' })).toBe(true);
    expect(test({ field: 'title', op: 'eq', value: 'bug' }, { title: 'Bug' })).toBe(false);
  });

  it('compares instants from ISO strings or Dates, and days as calendar dates', () => {
    const f: Filter = { field: 'createdAt', op: 'gte', value: '-P1D' };
    expect(test(f, { createdAt: new Date(NOW - 86_400_000).toISOString() })).toBe(true);
    expect(test(f, { createdAt: new Date(NOW - 86_400_001) })).toBe(false);
    expect(test({ field: 'dueOn', op: 'lt', value: '2026-11-06' }, { dueOn: '2026-11-05' })).toBe(
      true,
    );
  });

  it('obeys negation laws for every field, operator and value (property)', () => {
    const rowArb = fc.record(
      {
        title: fc.option(fc.constantFrom('', 'Bug', 'bug', 'İ'), { nil: null }),
        kind: fc.option(fc.constantFrom('bug', 'feature'), { nil: null }),
        priority: fc.option(fc.constantFrom(-0, 0, 1, 2.5), { nil: null }),
        done: fc.option(fc.boolean(), { nil: null }),
        assignee: fc.option(fc.constantFrom(ME, OTHER), { nil: null }),
        labels: fc.option(fc.uniqueArray(fc.constantFrom(ME, OTHER)), { nil: null }),
      },
      { requiredKeys: [] },
    );
    const pairs = [
      ['eq', 'neq'],
      ['in', 'nin'],
    ] as const;
    const cases = [
      { field: 'title', value: 'bug', list: ['Bug', ''] },
      { field: 'kind', value: 'bug', list: ['bug'] },
      { field: 'priority', value: 0, list: [0, 2.5] },
      { field: 'assignee', value: ME, list: [ME] },
      { field: 'labels', value: ME, list: [OTHER] },
    ] as const;
    fc.assert(
      fc.property(rowArb, (row) => {
        for (const { field, value, list } of cases) {
          const holds = (f: Filter) => test(f, row);
          for (const [pos, neg] of pairs) {
            const v: FilterValue = pos === 'eq' ? value : [...list];
            if (holds({ field, op: pos, value: v }) === holds({ field, op: neg, value: v })) {
              return false;
            }
          }
          if (
            holds({ field, op: 'exists', value: true }) ===
            holds({ field, op: 'exists', value: false })
          ) {
            return false;
          }
        }
        return true;
      }),
      propertyParameters({ seed: 20261106, numRuns: 500 }),
    );
  });

  it('accepts every operator OPS_BY_TYPE lists, for every field type', () => {
    const resolved: ResolvedFilter[] = Object.entries(FIELDS).flatMap(([field, def]) =>
      OPS_BY_TYPE[def.type].map((op) => resolve(sample(field, def, op))),
    );
    expect(resolved).toHaveLength(
      Object.values(FIELDS).reduce((n, def) => n + OPS_BY_TYPE[def.type].length, 0),
    );
  });
});

/** A valid condition for any field and operator. */
function sample(field: string, def: FilterField, op: FilterOp): Filter {
  const scalar = {
    text: 'x',
    enum: def.type === 'enum' ? (def.values[0] ?? '') : '',
    number: 1,
    boolean: true,
    instant: '-P1D',
    day: '2026-11-06',
    ref: 'me',
    refs: 'me',
  }[def.type];
  if (op === 'exists') return { field, op, value: true };
  if (op === 'in' || op === 'nin') {
    return { field, op, value: typeof scalar === 'boolean' ? [] : [scalar] };
  }
  return { field, op, value: scalar };
}
