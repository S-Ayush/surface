/**
 * A list over rows in memory (SPEC-003 §7.1): for server-only tables, which the executor's list
 * models (synced tables, `syncGroups`) don't cover, and which hold few rows (a team of 10–50
 * people): invites (PLAN-001 S5), sessions (S6). The handler reads them all; this filters, sorts
 * and pages with the shared filter evaluator the client uses. Same contract as every list:
 * keyset cursors bound to their sort, ties broken by id, nulls last, and a bad filter, sort or
 * cursor is `INVALID_INPUT`.
 */
import {
  FilterError,
  matches,
  resolveFilter,
  type Filter,
  type FilterFields,
} from '@surface/domain';
import { z } from 'zod';
import { SurfaceError } from '../executor/errors.js';

export interface MemoryListArgs {
  readonly filter?: Filter | undefined;
  readonly orderBy?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface MemoryListModel {
  /** Plural, for messages: "Can't sort invites by …". */
  readonly noun: string;
  readonly filterFields: FilterFields;
  /** Sortable fields: `instant` values are ISO strings, compared as times. */
  readonly orderFields: Readonly<Record<string, 'instant' | 'text'>>;
  readonly defaultOrder: { readonly field: string; readonly direction: 'asc' | 'desc' };
}

interface Key {
  readonly v: string | number | null;
  readonly id: string;
}

function invalid(path: readonly (string | number)[], message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path, message }] });
}

/** Ascending order of two keys: nulls last, then the value, then the id. */
function compareAsc(a: Key, b: Key): number {
  if (a.v !== b.v) {
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return a.v < b.v ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function encodeCursor(sort: string, key: Key): string {
  return Buffer.from(JSON.stringify({ s: sort, ...key })).toString('base64url');
}

const CursorSchema = z.object({
  s: z.string(),
  v: z.union([z.string(), z.number(), z.null()]),
  id: z.string(),
});

function decodeCursor(cursor: string, sort: string): Key {
  const bad = () =>
    invalid(['cursor'], 'This cursor is not from this list and sort. Start again without it.');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success || parsed.data.s !== sort) throw bad();
  return { v: parsed.data.v, id: parsed.data.id };
}

/** A field of a row by name, for the filter evaluator. */
function fieldOf(row: object, name: string): unknown {
  const record: Readonly<Record<string, unknown>> = { ...row };
  return record[name];
}

function sortValue(row: object, field: string, type: 'instant' | 'text'): string | number | null {
  const value = fieldOf(row, field);
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  return type === 'instant' ? Date.parse(value) : value;
}

/** One page of `all` (every row, already shaped) for `args`. */
export function memoryPage<Row extends { readonly id: string }>(
  model: MemoryListModel,
  all: readonly Row[],
  args: MemoryListArgs,
  context: { readonly now: Date; readonly me: string | null },
): { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const order = args.orderBy ?? model.defaultOrder;
  const type = Object.hasOwn(model.orderFields, order.field)
    ? model.orderFields[order.field]
    : undefined;
  if (type === undefined) {
    throw invalid(
      ['orderBy', 'field'],
      `Can't sort ${model.noun} by "${order.field}". Use one of: ${Object.keys(model.orderFields).join(', ')}.`,
    );
  }
  const field = order.field;
  const direction = order.direction ?? 'asc';
  const sort = `${field}:${direction}`;

  let rows = [...all];
  if (args.filter !== undefined) {
    let filter;
    try {
      filter = resolveFilter(args.filter, model.filterFields, {
        now: context.now.getTime(),
        timeZone: 'UTC',
        me: context.me,
      });
    } catch (error) {
      if (error instanceof FilterError) throw invalid(['filter', ...error.path], error.message);
      throw error;
    }
    rows = rows.filter((row) => matches(filter, row, fieldOf));
  }

  const keyOf = (row: Row): Key => ({ v: sortValue(row, field, type), id: row.id });
  // Descending reverses the value order but keeps nulls last.
  const compare = (a: Key, b: Key): number => {
    if (direction === 'asc' || a.v === null || b.v === null) return compareAsc(a, b);
    return -compareAsc(a, b);
  };
  rows.sort((a, b) => compare(keyOf(a), keyOf(b)));

  if (args.cursor !== undefined) {
    const after = decodeCursor(args.cursor, sort);
    rows = rows.filter((row) => compare(keyOf(row), after) > 0);
  }
  const nodes = rows.slice(0, args.limit);
  const last = nodes.at(-1);
  const hasNextPage = rows.length > nodes.length;
  return {
    nodes,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage && last ? encodeCursor(sort, keyOf(last)) : null,
    },
  };
}
