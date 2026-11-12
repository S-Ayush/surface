/**
 * The repo layer's bulk statements (SPEC-011 §5.1, PLAN-011 S1): `repo.updateWhere`,
 * `repo.deleteWhere` and the chunked `sync_log` insert of `flush`. Part of the repo layer: only
 * `sync/repo.ts` imports this module (dependency-cruiser `bulk-only-from-repo`), which runs the
 * statements and logs one `sync_log` row per row they touch (CLAUDE.md rule 2).
 *
 * Everything here is pure: it builds statements and checks rules without running anything, so
 * chunking, lock order and the unlogged-delete rule are unit-tested without Postgres.
 */
import { asc, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ModelName, ModelTable } from './models.js';

/**
 * Rows per statement, for `sync_log` inserts and the bulk writes. A `sync_log` row binds 8
 * parameters, so 5,000 rows stay under Postgres's limit of 65,535 per statement.
 */
export const SYNC_LOG_CHUNK = 5_000;

/** `items` in consecutive chunks of at most `size`. */
export function chunked<T>(items: readonly T[], size: number = SYNC_LOG_CHUNK): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be ≥ 1 (${size})`);
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * Distinct ids in ascending order, lower-cased. Postgres orders `uuid` by its bytes, which is the
 * order of the lower-case text, so rows are locked in the same order by every writer and two bulk
 * writes over overlapping ids can't deadlock (SPEC-011 §4.8).
 */
export function ascendingIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => id.toLowerCase()))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** One array parameter (`= ANY($1::uuid[])`), not one parameter per id. */
function anyOf(column: PgColumn, ids: readonly string[]): SQL {
  return sql`${column} = ANY(${sql.param(ids)}::uuid[])`;
}

/**
 * Columns `updateWhere` never writes. The id, timestamps and groups are the repo's. A field the
 * groups derive from would change them, and `updateWhere` keeps each row's stored groups, so it
 * refuses those too: `teamId` for every team-owned model (a team move is M3's, which rewrites
 * groups), `private` for Team. `id` also covers UserPreferences, whose groups come from it.
 */
const NEVER_PATCHED = ['id', 'createdAt', 'updatedAt', 'syncGroups', 'teamId'] as const;
const GROUP_FIELDS: Partial<Record<ModelName, readonly string[]>> = { Team: ['private'] };

/** Why `updateWhere` refuses this patch, or `undefined` when it may run. */
export function updateWhereProblem(model: ModelName, patch: object): string | undefined {
  const refused = [...NEVER_PATCHED, ...(GROUP_FIELDS[model] ?? [])];
  const touched = Object.keys(patch).filter((field) => refused.includes(field));
  if (touched.length === 0) return undefined;
  return `updateWhere on ${model} can't change ${touched.join(', ')}: it keeps each row's stored groups. Use repo.update for a change that moves rows between groups.`;
}

/**
 * The statements of `repo.updateWhere(model, ids, patch, { touchUpdatedAt })`, one lock and one
 * update per chunk of ascending ids. `updatedAt` is set to `now` only with `touchUpdatedAt`; an
 * empty patch writes no column at all (SPEC-011 §5.1: "log each row again").
 */
export function updateWhereStatements(
  db: NodePgDatabase,
  table: ModelTable<ModelName>,
  ids: Iterable<string>,
  patch: Readonly<Record<string, unknown>>,
  options: { readonly touchUpdatedAt: boolean; readonly now: Date },
) {
  const empty = Object.keys(patch).length === 0;
  const values = options.touchUpdatedAt ? { ...patch, updatedAt: options.now } : patch;
  return chunked(ascendingIds(ids)).map((chunk) => ({
    ids: chunk,
    lock: db
      .select()
      .from(table)
      .where(anyOf(table.id, chunk))
      .orderBy(asc(table.id))
      .for('update'),
    ...(empty
      ? {}
      : { update: db.update(table).set(values).where(anyOf(table.id, chunk)).returning() }),
  }));
}

/** A model field name that is a column of `table`, or a description of why not. */
export function columnOf(
  table: ModelTable<ModelName>,
  field: string,
): { readonly column: PgColumn } | { readonly problem: string } {
  const columns: Record<string, PgColumn> = getTableColumns(table);
  const column = Object.hasOwn(columns, field) ? columns[field] : undefined;
  if (column === undefined) return { problem: `has no column ${field}` };
  if (column.columnType !== 'PgUUID') return { problem: `column ${field} is not a uuid` };
  return { column };
}

/**
 * The statements of `repo.deleteWhere(model, column, ids)`: one
 * `DELETE … WHERE column = ANY($ids) RETURNING id, sync_groups` per chunk of ascending ids.
 */
export function deleteWhereStatements(
  db: NodePgDatabase,
  table: ModelTable<ModelName>,
  column: PgColumn,
  ids: Iterable<string>,
) {
  return chunked(ascendingIds(ids)).map((chunk) => ({
    ids: chunk,
    delete: db
      .delete(table)
      .where(anyOf(column, chunk))
      .returning({ id: table.id, groups: table.syncGroups }),
  }));
}

// ---------------------------------------------------------------------------------------------
// The one unlogged write (ADR-0022)

/** A content model's parent: the model, and the field of the content row that holds its id. */
export interface ContentParent {
  readonly model: string;
  readonly field: string;
}

/** A `deleteWhere(…, { log: false })`, kept until `flush` checks it. */
export interface UnloggedDelete {
  readonly model: string;
  /** The field the delete matched on: it must be the parent field. */
  readonly field: string;
  /** The parent ids the delete matched. */
  readonly parentIds: readonly string[];
  /** The rows it deleted. */
  readonly ids: readonly string[];
}

/** What the rule needs to know about a model: its load strategy and, for content, its parent. */
export interface ModelShape {
  readonly load: 'eager' | 'content';
  readonly parent?: ContentParent;
}

/**
 * The parent of a model that may be deleted unlogged, or why `deleteWhere(model, field, …,
 * { log: false })` is refused: only a content model, matched on its parent field (ADR-0022).
 */
export function unloggedParent(
  model: string,
  shape: ModelShape | undefined,
  field: string,
): { readonly parent: ContentParent } | { readonly problem: string } {
  const refused = `deleteWhere(${model}, { log: false }) refused`;
  if (shape === undefined) return { problem: `${refused}: unknown model.` };
  if (shape.load !== 'content') {
    return {
      problem: `${refused}: ${model} is not a content model. Only content rows whose parent is deleted in the same transaction may skip sync_log (ADR-0022).`,
    };
  }
  if (shape.parent === undefined) {
    return { problem: `${refused}: ${model} declares no parent (ADR-0022).` };
  }
  if (shape.parent.field !== field) {
    return {
      problem: `${refused}: it must match on the parent field ${shape.parent.field}, not ${field} (ADR-0022).`,
    };
  }
  return { parent: shape.parent };
}

/**
 * The assertion `flush` runs before it logs anything (ADR-0022, SPEC-011 §5.1): every unlogged
 * content delete names parents whose own row is deleted, with a logged `D`, in the same
 * transaction. `logged` are the transaction's buffered changes. Returns the first problem.
 */
export function unloggedDeleteProblem(
  unlogged: readonly UnloggedDelete[],
  logged: readonly { readonly action: string; readonly model: string; readonly id: string }[],
  shapeOf: (model: string) => ModelShape | undefined,
): string | undefined {
  for (const entry of unlogged) {
    const found = unloggedParent(entry.model, shapeOf(entry.model), entry.field);
    if ('problem' in found) return found.problem;
    const { parent } = found;
    const deleted = new Set(
      logged
        .filter((change) => change.action === 'D' && change.model === parent.model)
        .map((change) => change.id.toLowerCase()),
    );
    const kept = entry.parentIds.find((id) => !deleted.has(id.toLowerCase()));
    if (kept !== undefined) {
      return `deleteWhere(${entry.model}, { log: false }) refused: parent ${parent.model} ${kept} is not deleted with a logged D in this transaction (ADR-0022).`;
    }
  }
  return undefined;
}
