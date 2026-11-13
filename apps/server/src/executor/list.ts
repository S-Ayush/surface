/**
 * List, count and groupBy helpers (SPEC-003 §7.1, §7.3). Visibility (sync groups, and an API
 * key's teams) is applied in SQL before filtering, limits, counts and ordering, so nothing the
 * actor can't see is ever ordered past, counted, or grouped (permissions.md §5).
 *
 * Pagination is keyset: `ORDER BY key, id` with the key's nulls last, and an opaque cursor
 * holding the last row's key and id. Pages never overlap or skip rows that existed throughout.
 */
import {
  FilterError,
  FilterSchema,
  type Actor,
  type Filter,
  type FilterContext,
  type FilterFields,
  type RefEntity,
  type RefType,
} from '@surface/domain';
import { LIST_LIMIT_DEFAULT, type OrderBy } from '@surface/operations';
import {
  and,
  arrayOverlaps,
  asc,
  getTableColumns,
  inArray,
  isNull,
  sql,
  type Column,
  type SQL,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { SurfaceError } from './errors.js';
import { compileFilter, type FilterModel } from './filter-sql.js';
import { lookup } from './refs/sources.js';

/** Sort key types. Text sorts in the database collation; only the server orders by it. */
export type OrderType = 'text' | 'number' | 'instant' | 'day';

/**
 * Reference types a filter value may name (`"team": "ENG"`). Statuses and labels resolve within
 * the list's `scopeTeam` (PLAN-011 S4): a status name needs one, and a label name without one
 * matches workspace labels only, like inputs (SPEC-003 §4).
 */
export type FilterRefType = Extract<RefType, 'TeamRef' | 'UserRef' | 'StatusRef' | 'LabelRef'>;

type ColumnKey<T extends PgTable> = Extract<keyof T['_']['columns'], string>;
type Row<T extends PgTable> = T['$inferSelect'];

export interface ListModel<T extends PgTable, F extends FilterFields = FilterFields> {
  readonly table: T;
  /** The model's filterable fields and their SQL (`filter-sql.ts`). */
  readonly filter: FilterModel<F>;
  /** Filter fields whose values may be names or keys, resolved like inputs (§7.4). */
  readonly filterRefs?: { readonly [K in keyof F]?: FilterRefType };
  /** Sortable columns. */
  readonly order: { readonly [K in ColumnKey<T>]?: OrderType };
  readonly defaultOrder: { readonly field: ColumnKey<T>; readonly direction: 'asc' | 'desc' };
  /** The row's team, filtered by an API key's teams; `null` for workspace-wide models. */
  readonly teamColumn: ColumnKey<T> | null;
  /** Rows with a value here are archived and listed only with `includeArchived`. */
  readonly archivedColumn?: ColumnKey<T>;
  /** Rows with a value here are never listed, counted or grouped (deleted issues, SPEC-011 §6.1). */
  readonly deletedColumn?: ColumnKey<T>;
  /**
   * Groupings for `*.groupBy`, by name. `key` is a text expression (null for "none") and
   * `label` its display name. A label read from another synced table must apply the actor's
   * groups, as filter dot-paths do. `lateral` joins a set per row (`LEFT JOIN LATERAL … ON
   * TRUE`), so a row counts once in each of its values, like an issue in each of its labels.
   */
  readonly groupings?: (groups: readonly string[]) => {
    readonly [name: string]: {
      readonly key: SQL;
      readonly label: SQL;
      readonly lateral?: SQL;
    };
  };
  /** Summed per group as `estimateSum`. */
  readonly estimateColumn?: ColumnKey<T>;
}

/** Checks the model's columns once, at module load, so a typo fails startup, not a request. */
export function defineListModel<T extends PgTable, F extends FilterFields>(
  model: ListModel<T, F>,
): ListModel<T, F> {
  const columns = getTableColumns(model.table);
  for (const required of ['id', 'syncGroups']) {
    if (!(required in columns)) throw new Error(`List model needs a "${required}" column`);
  }
  if (model.order[model.defaultOrder.field] === undefined) {
    throw new Error(`Default order "${model.defaultOrder.field}" is not a sortable column`);
  }
  return model;
}

export interface ListArgs {
  readonly filter?: Filter | undefined;
  /** The team status and label names in the filter resolve within. */
  readonly scopeTeam?: RefEntity | undefined;
  readonly orderBy?: OrderBy | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  /** Adds `totalCount` (one more query). */
  readonly withTotal?: boolean;
}

export interface CountArgs {
  readonly filter?: Filter | undefined;
  readonly includeArchived?: boolean | undefined;
  /** The team status and label names in the filter resolve within (`team` of the input). */
  readonly scopeTeam?: RefEntity | undefined;
}

export interface GroupByArgs extends CountArgs {
  readonly groupBy: string;
  /** At most this many groups, the largest first. */
  readonly limit?: number;
}

export interface Page<R> {
  readonly nodes: R[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly totalCount?: number;
}

export interface Group {
  readonly key: string | null;
  readonly label: string;
  readonly count: number;
  readonly estimateSum?: number;
}

/** What the helpers run with: the handler's transaction and the (key-narrowed) actor. */
export interface ListContext {
  readonly tx: NodePgDatabase;
  /** The same connection, for the reference resolvers. */
  readonly client: Queryable;
  readonly actor: Actor;
  readonly filterContext: FilterContext;
}

export async function listQuery<T extends PgTable, F extends FilterFields>(
  ctx: ListContext,
  model: ListModel<T, F>,
  args: ListArgs,
): Promise<Page<Row<T>>> {
  const columns = getTableColumns(model.table);
  const order = orderOf(model, args.orderBy);
  const key = columnOf(columns, order.field);
  const id = columnOf(columns, 'id');
  const limit = args.limit ?? LIST_LIMIT_DEFAULT;

  const where = await baseWhere(ctx, model, args);
  const after = args.cursor === undefined ? undefined : afterCursor(args.cursor, order, key, id);
  const direction = order.direction === 'asc' ? sql`ASC` : sql`DESC`;

  // Widened for Drizzle's builder, which can't check a generic table; rows are still `Row<T>`.
  const table: PgTable = model.table;
  const rows: Row<T>[] = await ctx.tx
    .select()
    .from(table)
    .where(and(where, after))
    .orderBy(sql`${key} ${direction} NULLS LAST`, asc(id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const nodes = hasNextPage ? rows.slice(0, limit) : rows;
  const last = nodes.at(-1);
  const page: Page<Row<T>> = {
    nodes,
    pageInfo: {
      hasNextPage,
      endCursor: last === undefined ? null : encodeCursor(order, rowValue(last, order.field), last),
    },
  };
  if (!args.withTotal) return page;
  return { ...page, totalCount: await countWhere(ctx.tx, model.table, where) };
}

export async function countQuery<T extends PgTable, F extends FilterFields>(
  ctx: ListContext,
  model: ListModel<T, F>,
  args: CountArgs,
): Promise<number> {
  return countWhere(ctx.tx, model.table, await baseWhere(ctx, model, args));
}

export async function groupByQuery<T extends PgTable, F extends FilterFields>(
  ctx: ListContext,
  model: ListModel<T, F>,
  args: GroupByArgs,
): Promise<Group[]> {
  const groupings = model.groupings?.(ctx.actor.groups) ?? {};
  const grouping = Object.hasOwn(groupings, args.groupBy) ? groupings[args.groupBy] : undefined;
  if (grouping === undefined) {
    const names = Object.keys(groupings).sort();
    throw invalid(
      ['groupBy'],
      names.length > 0
        ? `Can't group by "${clip(args.groupBy)}". Group by one of: ${names.join(', ')}.`
        : "This list can't be grouped.",
    );
  }
  const where = await baseWhere(ctx, model, args);
  const table: PgTable = model.table;
  const columns = getTableColumns(model.table);
  const estimate =
    model.estimateColumn === undefined ? undefined : columnOf(columns, model.estimateColumn);
  const limit = args.limit === undefined ? undefined : sql`LIMIT ${args.limit}`;
  if (grouping.lateral !== undefined) {
    // A row counts in each of its values: one join row per value (`lateral`), so plain SQL.
    const result = await ctx.tx.execute<{
      key: string | null;
      label: string | null;
      count: number;
    }>(
      sql`SELECT ${grouping.key} AS key, ${grouping.label} AS label, count(*)::int AS count
            FROM ${table} LEFT JOIN LATERAL ${grouping.lateral} ON TRUE
           WHERE ${where ?? sql`TRUE`}
           GROUP BY 1, 2 ORDER BY 3 DESC, 1 ASC NULLS LAST ${limit ?? sql``}`,
    );
    return result.rows.map((row) => ({
      key: row.key,
      label: row.label ?? 'None',
      count: row.count,
    }));
  }
  const query = ctx.tx
    .select({
      key: sql<string | null>`${grouping.key}`,
      label: sql<string | null>`${grouping.label}`,
      count: sql<number>`count(*)::int`,
      ...(estimate ? { estimateSum: sql<number>`coalesce(sum(${estimate}), 0)::float8` } : {}),
    })
    .from(table)
    .where(where)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`3 DESC`, sql`1 ASC NULLS LAST`)
    .$dynamic();
  const rows = await (args.limit === undefined ? query : query.limit(args.limit));
  return rows.map((row) => ({
    key: row.key,
    label: row.label ?? 'None',
    count: row.count,
    ...(row.estimateSum === undefined ? {} : { estimateSum: row.estimateSum }),
  }));
}

/**
 * Rows the actor may see: overlapping sync groups and, for an API key limited to some teams,
 * those teams only. The system actor sees everything. Shared with `ctx.query.get`.
 */
export function visibleTo(
  actor: Actor,
  syncGroups: Column,
  teamColumn: Column | null,
): SQL | undefined {
  if (actor.kind === 'system') return undefined;
  const keyTeams = actor.apiKey?.teamIds ?? [];
  return and(
    arrayOverlaps(syncGroups, [...actor.groups]),
    keyTeams.length > 0 && teamColumn ? inArray(teamColumn, [...keyTeams]) : undefined,
  );
}

// ---------------------------------------------------------------------------------------------

async function baseWhere<T extends PgTable, F extends FilterFields>(
  ctx: ListContext,
  model: ListModel<T, F>,
  args: CountArgs,
): Promise<SQL | undefined> {
  const columns = getTableColumns(model.table);
  const team = model.teamColumn === null ? null : columnOf(columns, model.teamColumn);
  const visible = visibleTo(ctx.actor, columnOf(columns, 'syncGroups'), team);
  const live =
    model.archivedColumn === undefined || args.includeArchived
      ? undefined
      : isNull(columnOf(columns, model.archivedColumn));
  const present =
    model.deletedColumn === undefined ? undefined : isNull(columnOf(columns, model.deletedColumn));
  const filtered =
    args.filter === undefined
      ? undefined
      : compile(await resolveFilterRefs(ctx, model, args.filter, args.scopeTeam), model, ctx);
  return and(visible, present, live, filtered);
}

function compile<F extends FilterFields>(
  filter: Filter,
  model: ListModel<PgTable, F>,
  ctx: ListContext,
): SQL {
  try {
    return compileFilter(filter, model.filter, ctx.filterContext, { groups: ctx.actor.groups });
  } catch (error) {
    if (error instanceof FilterError) throw invalid(['filter', ...error.path], error.message);
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces names and keys in reference conditions with ids (SPEC-003 §7.4), using the same
 * resolvers, visibility and messages as inputs: an invisible team is `NOT_FOUND`.
 */
async function resolveFilterRefs<F extends FilterFields>(
  ctx: ListContext,
  model: ListModel<PgTable, F>,
  filter: Filter,
  scopeTeam: RefEntity | undefined,
): Promise<Filter> {
  const refs: Readonly<Record<string, FilterRefType | undefined>> = model.filterRefs ?? {};
  if (Object.keys(refs).length === 0) return filter;

  const resolveValue = async (type: FilterRefType, value: unknown, path: (string | number)[]) => {
    if (typeof value !== 'string' || value === 'me' || UUID.test(value)) return value;
    const row = await lookup(type, value, {
      db: ctx.client,
      actor: ctx.actor,
      path,
      // Statuses and labels by name resolve within the list's team, like inputs (SPEC-003 §4).
      ...(scopeTeam === undefined ? {} : { scopeTeam }),
      // Filtering by a deactivated user ("assigned to Sam, who left") is legitimate.
      allowInactive: true,
    });
    return row.id;
  };

  const walk = async (node: Filter, path: (string | number)[]): Promise<Filter> => {
    if ('and' in node) {
      return { and: await mapSequential(node.and, (c, i) => walk(c, [...path, 'and', i])) };
    }
    if ('or' in node) {
      return { or: await mapSequential(node.or, (c, i) => walk(c, [...path, 'or', i])) };
    }
    const type = Object.hasOwn(refs, node.field) ? refs[node.field] : undefined;
    if (type === undefined) return node;
    const at = [...path, 'value'];
    const value = Array.isArray(node.value)
      ? await mapSequential(node.value, (v, i) => resolveValue(type, v, [...at, i]))
      : await resolveValue(type, node.value, at);
    // Re-validated by compileFilter; ids are plain strings, so the shape is unchanged.
    return FilterSchema.parse({ ...node, value });
  };
  return walk(filter, ['filter']);
}

async function mapSequential<A, B>(
  items: readonly A[],
  fn: (item: A, index: number) => Promise<B>,
): Promise<B[]> {
  const out: B[] = [];
  for (const [i, item] of items.entries()) out.push(await fn(item, i));
  return out;
}

async function countWhere(
  tx: NodePgDatabase,
  table: PgTable,
  where: SQL | undefined,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return row?.count ?? 0;
}

interface ResolvedOrder {
  readonly field: string;
  readonly type: OrderType;
  readonly direction: 'asc' | 'desc';
}

function orderOf<T extends PgTable, F extends FilterFields>(
  model: ListModel<T, F>,
  orderBy: OrderBy | undefined,
): ResolvedOrder {
  const sortable: Readonly<Record<string, OrderType | undefined>> = model.order;
  const field = orderBy?.field ?? model.defaultOrder.field;
  const type = Object.hasOwn(sortable, field) ? sortable[field] : undefined;
  if (type === undefined) {
    const names = Object.keys(sortable).sort();
    throw invalid(
      ['orderBy', 'field'],
      `Can't sort by "${clip(field)}". Sort by one of: ${names.join(', ')}.`,
    );
  }
  return { field, type, direction: orderBy?.direction ?? model.defaultOrder.direction };
}

function columnOf(columns: Record<string, Column>, name: string): PgColumn {
  const column = columns[name];
  if (column === undefined) throw new Error(`List model has no column "${name}"`);
  return column as PgColumn;
}

function rowValue(row: object, field: string): unknown {
  return (row as Record<string, unknown>)[field];
}

// ---------------------------------------------------------------------------------------------
// Cursors: base64url JSON of the sort, the last row's key and its id. Opaque to callers, but
// checked on the way back in, since they arrive from outside.

type CursorKey = string | number | null;

const CursorSchema = z.strictObject({
  f: z.string(),
  d: z.enum(['asc', 'desc']),
  k: z.union([z.string(), z.number(), z.null()]),
  i: z.uuid(),
});

const BAD_CURSOR = 'This cursor is not valid. Use pageInfo.endCursor from the previous page.';

function encodeCursor(order: ResolvedOrder, value: unknown, row: object): string {
  const payload = {
    f: order.field,
    d: order.direction,
    k: cursorKey(order.type, value),
    i: String(rowValue(row, 'id')),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function cursorKey(type: OrderType, value: unknown): CursorKey {
  if (value === null || value === undefined) return null;
  if (type === 'instant' && value instanceof Date) return value.toISOString();
  if (type === 'number' && typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  throw new Error(`Unexpected ${type} sort value`);
}

function afterCursor(cursor: string, order: ResolvedOrder, key: PgColumn, id: PgColumn): SQL {
  const decoded = decodeCursor(cursor);
  if (!decoded) throw invalid(['cursor'], BAD_CURSOR);
  if (decoded.f !== order.field || decoded.d !== order.direction) {
    throw invalid(
      ['cursor'],
      'This cursor belongs to a different sort order. Drop the cursor to start from the first page.',
    );
  }
  const value = keyParam(order.type, decoded.k);
  if (value === undefined) throw invalid(['cursor'], BAD_CURSOR);
  const lastId = sql`${decoded.i}::uuid`;
  if (value === null) return sql`(${key} IS NULL AND ${id} > ${lastId})`;
  const beyond = order.direction === 'asc' ? sql`${key} > ${value}` : sql`${key} < ${value}`;
  // Nulls sort last in both directions, so every null row comes after any non-null key.
  return sql`(${beyond} OR (${key} = ${value} AND ${id} > ${lastId}) OR ${key} IS NULL)`;
}

function decodeCursor(cursor: string): z.output<typeof CursorSchema> | undefined {
  try {
    const json: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = CursorSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The cursor key as a typed SQL parameter; `undefined` when it doesn't fit the sort type. */
function keyParam(type: OrderType, key: CursorKey): SQL | null | undefined {
  if (key === null) return null;
  switch (type) {
    case 'text':
      return typeof key === 'string' ? sql`${key}::text` : undefined;
    case 'number':
      return typeof key === 'number' && Number.isFinite(key)
        ? sql`${key}::double precision`
        : undefined;
    case 'instant':
      return typeof key === 'string' && !Number.isNaN(Date.parse(key))
        ? sql`${key}::timestamptz`
        : undefined;
    case 'day':
      return typeof key === 'string' && DAY.test(key) ? sql`${key}::date` : undefined;
  }
}

function invalid(path: readonly (string | number)[], message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path, message }] });
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
