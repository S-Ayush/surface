/**
 * Compile a resolved Filter to a SQL condition (SPEC-003 §7.1, §7.4). It must
 * agree exactly with the client evaluator (`@surface/domain` `matches`); see
 * `test/filter-conformance.int.test.ts`.
 *
 * Two-valued logic in SQL: every leaf is TRUE, FALSE, or NULL only where the
 * client says false, and leaves are combined with AND/OR only. NOT appears only
 * around expressions that are never NULL, so NULL can't flip a negation.
 */
import {
  resolveFilter,
  type FieldType,
  type Filter,
  type FilterContext,
  type FilterFields,
  type ResolvedFilter,
  type ResolvedScalar,
} from '@surface/domain';
import { sql, type SQL } from 'drizzle-orm';

/** What the acting user may see: their sync groups (permissions.md §5). */
export interface VisibilityScope {
  groups: readonly string[];
}

/**
 * A model's filterable fields with the SQL expression behind each one.
 *
 * Plain columns are `sql\`i.title\``. A dot-path (`status.category`,
 * `parent.title`) is a scalar subquery into another table, and **any subquery
 * into a synced table must apply `scope.groups`** (`… AND x.sync_groups &&
 * ${sql.param([...scope.groups])}::text[]`). Otherwise a filter can probe rows the
 * actor can't see, one `contains` at a time (CLAUDE.md rule 4), and SQL would
 * disagree with the client, whose replica doesn't have those rows.
 *
 * Column types: `text`/`enum` text; `number` integer, smallint or double
 * precision (types the wire delivers as JS numbers); `instant` timestamptz(3);
 * `day` date; `ref` uuid; `refs` uuid[].
 */
export interface FilterModel<F extends FilterFields> {
  fields: F;
  columns: (scope: VisibilityScope) => { readonly [K in keyof F]: SQL };
}

export function defineFilterModel<F extends FilterFields>(model: FilterModel<F>): FilterModel<F> {
  return model;
}

/**
 * Validate `filter` against the model, resolve relative values, and compile it
 * to a SQL condition. Throws `FilterError` (→ `INVALID_INPUT`) for a bad filter.
 */
export function compileFilter<F extends FilterFields>(
  filter: Filter,
  model: FilterModel<F>,
  ctx: FilterContext,
  scope: VisibilityScope,
): SQL {
  const columns: Readonly<Record<string, SQL | undefined>> = model.columns(scope);
  return compileNode(resolveFilter(filter, model.fields, ctx), columns);
}

function compileNode(
  filter: ResolvedFilter,
  columns: Readonly<Record<string, SQL | undefined>>,
): SQL {
  switch (filter.kind) {
    case 'and':
    case 'or': {
      if (filter.children.length === 0) return filter.kind === 'and' ? sql`TRUE` : sql`FALSE`;
      const parts = filter.children.map((c) => compileNode(c, columns));
      return sql`(${sql.join(parts, filter.kind === 'and' ? sql` AND ` : sql` OR `)})`;
    }
    case 'cond':
      break;
  }

  const col = columns[filter.field];
  if (!col) throw new Error(`No SQL column mapped for filter field "${filter.field}"`);

  const type = filter.type;
  if (type === 'refs') {
    const ids = sql`coalesce(${col}, '{}'::uuid[])`;
    const list = (values: readonly ResolvedScalar[]) =>
      sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::uuid[]`;
    switch (filter.op) {
      case 'exists':
        return filter.value ? sql`cardinality(${ids}) > 0` : sql`cardinality(${ids}) = 0`;
      case 'eq':
        return sql`${ids} @> ${list([filter.value])}`;
      case 'neq':
        return sql`NOT (${ids} @> ${list([filter.value])})`;
      case 'in':
        return filter.value.length === 0 ? sql`FALSE` : sql`${ids} && ${list(filter.value)}`;
      case 'nin':
        return filter.value.length === 0 ? sql`TRUE` : sql`NOT (${ids} && ${list(filter.value)})`;
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
      case 'contains':
        // resolveFilter never produces these for sets (OPS_BY_TYPE.refs).
        throw new Error(`"${filter.op}" is not valid for set field "${filter.field}"`);
    }
  }

  const p = (v: ResolvedScalar) => param(type, v);
  switch (filter.op) {
    case 'exists':
      return filter.value ? sql`${col} IS NOT NULL` : sql`${col} IS NULL`;
    case 'eq':
      return sql`${col} = ${p(filter.value)}`;
    case 'neq':
      return sql`${col} IS DISTINCT FROM ${p(filter.value)}`;
    case 'in':
      return filter.value.length === 0
        ? sql`FALSE`
        : sql`${col} IN (${sql.join(filter.value.map(p), sql`, `)})`;
    case 'nin':
      return filter.value.length === 0
        ? sql`TRUE`
        : sql`(${col} IS NULL OR ${col} NOT IN (${sql.join(filter.value.map(p), sql`, `)}))`;
    case 'lt':
      return sql`${col} < ${p(filter.value)}`;
    case 'lte':
      return sql`${col} <= ${p(filter.value)}`;
    case 'gt':
      return sql`${col} > ${p(filter.value)}`;
    case 'gte':
      return sql`${col} >= ${p(filter.value)}`;
    case 'contains':
      // ICU root lowercasing is the same full Unicode mapping as JS toLowerCase();
      // the database default (libc) is not. strpos avoids LIKE wildcard escaping.
      return sql`strpos(lower(${col} COLLATE "und-x-icu"), lower(${p(filter.value)} COLLATE "und-x-icu")) > 0`;
  }
}

/** A bound parameter with an explicit type, so Postgres never guesses. */
function param(type: Exclude<FieldType, 'refs'>, value: ResolvedScalar): SQL {
  switch (type) {
    case 'text':
    case 'enum':
      return sql`${value}::text`;
    case 'number':
      // numeric holds every JS number exactly as written (shortest round-trip form).
      return sql`${value}::numeric`;
    case 'boolean':
      return sql`${value}::boolean`;
    case 'instant':
      return sql`${typeof value === 'number' ? new Date(value).toISOString() : value}::timestamptz`;
    case 'day':
      return sql`${value}::date`;
    case 'ref':
      return sql`${value}::uuid`;
  }
}
