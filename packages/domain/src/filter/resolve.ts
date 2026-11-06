/**
 * Check a Filter against a model's fields and turn relative values into absolute
 * ones (SPEC-003 §7.4). The client evaluator and the SQL compiler both consume
 * the result, so they always see the same values.
 */
import type { Filter, FilterScalar, FilterValue } from './ast.js';
import {
  opsFor,
  type FieldType,
  type FilterField,
  type FilterFields,
  type FilterOp,
} from './fields.js';
import {
  addDays,
  isValidDay,
  MAX_INSTANT,
  MIN_INSTANT,
  parseDuration,
  parseInstant,
  shiftInstant,
  todayIn,
} from './time.js';

export interface FilterContext {
  /** Milliseconds since the epoch; the reference for durations. */
  now: number;
  /** IANA zone used for `day` durations ("today" depends on it). */
  timeZone: string;
  /** The acting user's id, which `me` stands for; null when there is none. */
  me: string | null;
}

/** A scalar after resolution. Instants are epoch milliseconds; days are `YYYY-MM-DD`. */
export type ResolvedScalar = string | number | boolean;

interface CondBase {
  kind: 'cond';
  field: string;
  type: FieldType;
}
export type ResolvedCondition =
  | (CondBase & { op: 'exists'; value: boolean })
  | (CondBase & { op: 'in' | 'nin'; value: readonly ResolvedScalar[] })
  | (CondBase & { op: Exclude<FilterOp, 'exists' | 'in' | 'nin'>; value: ResolvedScalar });

export type ResolvedFilter =
  { kind: 'and' | 'or'; children: readonly ResolvedFilter[] } | ResolvedCondition;

export type FilterPath = readonly (string | number)[];

/** The filter doesn't fit the model; maps to `INVALID_INPUT`. */
export class FilterError extends Error {
  override readonly name = 'FilterError';
  constructor(
    message: string,
    readonly path: FilterPath,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveFilter(
  filter: Filter,
  fields: FilterFields,
  ctx: FilterContext,
): ResolvedFilter {
  return resolveNode(filter, fields, ctx, []);
}

function resolveNode(
  node: Filter,
  fields: FilterFields,
  ctx: FilterContext,
  path: FilterPath,
): ResolvedFilter {
  if ('and' in node) {
    return {
      kind: 'and',
      children: node.and.map((c, i) => resolveNode(c, fields, ctx, [...path, 'and', i])),
    };
  }
  if ('or' in node) {
    return {
      kind: 'or',
      children: node.or.map((c, i) => resolveNode(c, fields, ctx, [...path, 'or', i])),
    };
  }

  const field = fields[node.field];
  if (!field) {
    throw new FilterError(
      `Unknown filter field "${node.field}". Use one of: ${Object.keys(fields).join(', ')}.`,
      [...path, 'field'],
    );
  }
  const ops = opsFor(field);
  if (!ops.includes(node.op)) {
    throw new FilterError(
      `Filter field "${node.field}" (${field.type}) does not support "${node.op}". Use one of: ${ops.join(', ')}.`,
      [...path, 'op'],
    );
  }

  const base = { kind: 'cond', field: node.field, type: field.type } as const;
  const valuePath = [...path, 'value'];
  const value = node.value;

  if (node.op === 'exists') {
    if (typeof value !== 'boolean') {
      throw new FilterError(`"exists" takes true or false.`, valuePath);
    }
    return { ...base, op: 'exists', value };
  }
  if (node.op === 'in' || node.op === 'nin') {
    if (!Array.isArray(value)) {
      throw new FilterError(`"${node.op}" takes a list of values, like ["a", "b"].`, valuePath);
    }
    return {
      ...base,
      op: node.op,
      value: value.map((v, i) =>
        resolveScalar(node.field, field, node.op, v, ctx, [...valuePath, i]),
      ),
    };
  }
  return {
    ...base,
    op: node.op,
    value: resolveScalar(node.field, field, node.op, value, ctx, valuePath),
  };
}

function resolveScalar(
  name: string,
  field: FilterField,
  op: FilterOp,
  value: FilterValue,
  ctx: FilterContext,
  path: FilterPath,
): ResolvedScalar {
  const fail = (expected: string): never => {
    throw new FilterError(`Filter field "${name}" needs ${expected}.`, path);
  };
  if (Array.isArray(value)) return fail(`a single value for "${op}"; lists go with "in" or "nin"`);

  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? value : fail('text');
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
        ? value
        : fail(`one of: ${field.values.join(', ')}`);
    case 'number':
      return typeof value === 'number' ? value : fail('a number');
    case 'boolean':
      return typeof value === 'boolean' ? value : fail('true or false');
    case 'ref':
    case 'refs':
      return resolveId(value, ctx, fail);
    case 'instant':
      return resolveInstant(value, ctx, fail);
    case 'day':
      return resolveDay(value, ctx, fail);
  }
}

function resolveId(value: FilterScalar, ctx: FilterContext, fail: (e: string) => never): string {
  if (value === 'me') {
    if (ctx.me === null) return fail('a specific id: "me" only works for a signed-in user');
    // The context comes from the server or the store, not the user: a bad id is a bug.
    if (!UUID.test(ctx.me)) throw new Error(`FilterContext.me is not a uuid: "${ctx.me}"`);
    return ctx.me.toLowerCase();
  }
  // Ids are compared as lowercase text on both sides.
  return typeof value === 'string' && UUID.test(value)
    ? value.toLowerCase()
    : fail('an id (uuid) or "me"');
}

const INSTANT_HINT =
  'a date-time with a time zone, like 2026-11-06T09:00:00Z, or a duration, like -P14D';

function resolveInstant(
  value: FilterScalar,
  ctx: FilterContext,
  fail: (e: string) => never,
): number {
  if (typeof value !== 'string') return fail(INSTANT_HINT);
  const duration = parseDuration(value);
  const ms = parseInstant(value) ?? (duration ? shiftInstant(ctx.now, duration) : undefined);
  if (ms === undefined) return fail(INSTANT_HINT);
  // Postgres (and ISO strings without extended years) stop at these bounds.
  if (ms < MIN_INSTANT || ms > MAX_INSTANT) {
    return fail('a date-time between years 1 and 9999 (UTC)');
  }
  return ms;
}

const DAY_HINT = 'a date like 2026-11-06, or a whole-day duration like -P7D or P2W';

function resolveDay(value: FilterScalar, ctx: FilterContext, fail: (e: string) => never): string {
  if (typeof value !== 'string') return fail(DAY_HINT);
  if (isValidDay(value)) return value;
  const d = parseDuration(value);
  if (!d || d.hours !== 0 || d.minutes !== 0) return fail(DAY_HINT);
  let today: string;
  try {
    today = todayIn(ctx.now, ctx.timeZone);
  } catch (error) {
    // The zone comes from settings, not from the filter: not the user's input error.
    throw new Error(`FilterContext.timeZone is not a known IANA time zone: "${ctx.timeZone}"`, {
      cause: error,
    });
  }
  return addDays(today, d.sign * (d.weeks * 7 + d.days)) ?? fail('a date between years 1 and 9999');
}
