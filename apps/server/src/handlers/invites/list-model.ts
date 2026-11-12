/**
 * `invite.list` over rows in memory (SPEC-003 §7.1; PLAN-001 S5). The executor's list models need
 * a synced table (`syncGroups`), and invites are server-only; there are few of them (a team of
 * 10–50 people), so the handler reads them all and filters, sorts and pages here, with the shared
 * filter evaluator the client uses. Same contract as every list: keyset cursors bound to their
 * sort, ties broken by id, nulls last, a bad filter, sort or cursor is `INVALID_INPUT`.
 */
import {
  defineFilterFields,
  FilterError,
  INVITE_STATUSES,
  matches,
  resolveFilter,
  USER_ROLES,
  type Filter,
} from '@surface/domain';
import type { InviteSchema } from '@surface/operations';
import { z } from 'zod';
import { SurfaceError } from '../../executor/errors.js';

type Invite = z.input<typeof InviteSchema>;

export const INVITE_FILTER_FIELDS = defineFilterFields({
  status: { type: 'enum', values: INVITE_STATUSES },
  email: { type: 'text' },
  role: { type: 'enum', values: USER_ROLES },
  createdAt: { type: 'instant' },
  expiresAt: { type: 'instant' },
});

const ORDER_FIELDS = { createdAt: 'instant', expiresAt: 'instant', email: 'text' } as const;
type OrderField = keyof typeof ORDER_FIELDS;

const DEFAULT_ORDER = { field: 'createdAt', direction: 'desc' } as const;

export interface InviteListArgs {
  readonly filter?: Filter | undefined;
  readonly orderBy?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

interface Key {
  readonly v: string | number | null;
  readonly id: string;
}

function invalid(path: readonly (string | number)[], message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path, message }] });
}

function isOrderField(field: string): field is OrderField {
  return Object.hasOwn(ORDER_FIELDS, field);
}

function sortValue(invite: Invite, field: OrderField): string | number | null {
  const value = invite[field];
  if (value === null) return null;
  return ORDER_FIELDS[field] === 'instant' ? Date.parse(value) : value;
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

/** A field of an invite by name, for the filter evaluator. */
function fieldOf(invite: Invite, name: string): unknown {
  const record: Readonly<Record<string, unknown>> = { ...invite };
  return record[name];
}

/** One page of `invites` (all of them, already shaped) for `args`. */
export function invitePage(
  invites: readonly Invite[],
  args: InviteListArgs,
  context: { readonly now: Date; readonly me: string | null },
): { nodes: Invite[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const order = args.orderBy ?? DEFAULT_ORDER;
  if (!isOrderField(order.field)) {
    throw invalid(
      ['orderBy', 'field'],
      `Can't sort invites by "${order.field}". Use one of: ${Object.keys(ORDER_FIELDS).join(', ')}.`,
    );
  }
  const field = order.field;
  const direction = order.direction ?? 'asc';
  const sort = `${field}:${direction}`;

  let rows = [...invites];
  if (args.filter !== undefined) {
    let filter;
    try {
      filter = resolveFilter(args.filter, INVITE_FILTER_FIELDS, {
        now: context.now.getTime(),
        timeZone: 'UTC',
        me: context.me,
      });
    } catch (error) {
      if (error instanceof FilterError) throw invalid(['filter', ...error.path], error.message);
      throw error;
    }
    rows = rows.filter((invite) => matches(filter, invite, fieldOf));
  }

  const keyOf = (invite: Invite): Key => ({ v: sortValue(invite, field), id: invite.id });
  // Descending reverses the value order but keeps nulls last.
  const compare = (a: Key, b: Key): number => {
    if (direction === 'asc' || a.v === null || b.v === null) return compareAsc(a, b);
    return -compareAsc(a, b);
  };
  rows.sort((a, b) => compare(keyOf(a), keyOf(b)));

  if (args.cursor !== undefined) {
    const after = decodeCursor(args.cursor, sort);
    rows = rows.filter((invite) => compare(keyOf(invite), after) > 0);
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
