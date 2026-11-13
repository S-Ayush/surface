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
import { SYNCED_MODELS, type ModelName, type ModelTable } from './models.js';

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
 * Distinct ids in ascending order, lower-cased: the order Postgres gives `uuid` (by its bytes, the
 * order of the lower-case text). Chunks of these ids are locked one after another, each by a
 * `SELECT … ORDER BY id FOR UPDATE`, so a bulk write takes its row locks in ascending id like
 * every other writer (SPEC-011 §4.8, SPEC-015 §4.4, sync-protocol §7).
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
 * Columns `updateWhere` never writes, on any model. The id, timestamps and groups are the repo's,
 * and archive state travels as `A`/`V` packets (`repo.archive`, `repo.unarchive`; SPEC-011 §5.5),
 * never inside a `U`. Each model's `groupFields` (`SYNCED_MODELS`) are refused too: `updateWhere`
 * keeps each row's stored groups, so it must not change a field they derive from.
 */
const NEVER_PATCHED = ['id', 'createdAt', 'updatedAt', 'syncGroups', 'archivedAt'] as const;

/** The fields a patch sets: `undefined` values set nothing (Drizzle skips them). */
export function patchedFields(patch: object): string[] {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

/** Why `updateWhere` refuses this patch, or `undefined` when it may run. */
export function updateWhereProblem(model: ModelName, patch: object): string | undefined {
  const refused: readonly string[] = [...NEVER_PATCHED, ...SYNCED_MODELS[model].groupFields];
  const touched = patchedFields(patch).filter((field) => refused.includes(field));
  if (touched.length === 0) return undefined;
  return `updateWhere on ${model} can't change ${touched.join(', ')}: it keeps each row's stored groups and logs only U. Use repo.update, repo.archive or repo.unarchive for that.`;
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
  const empty = patchedFields(patch).length === 0;
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

/** How `deleteWhereStatements` orders and cuts the rows. */
export interface DeleteOrder {
  /**
   * A self-reference (`comments.parent_comment_id`): rows that have one go first, so a chunk
   * never deletes a row another row still references through a `RESTRICT` key (SPEC-013 §4.3,
   * replies before roots). Without it, rows go in ascending id.
   */
  readonly childrenFirst?: PgColumn;
  /** Rows per delete statement. Default `SYNC_LOG_CHUNK`; tests pass a small one. */
  readonly chunkSize?: number;
}

/**
 * The statements of `repo.deleteWhere(model, column, values)`. A bare `DELETE … WHERE column = ANY`
 * locks rows in scan order, so the rows are locked first, in ascending id, by one
 * `SELECT id … WHERE column = ANY($values) ORDER BY id FOR UPDATE` (`lock`); then `deletes(ids)`
 * gives one `DELETE … WHERE id = ANY($chunk) RETURNING id, sync_groups` per chunk of the locked
 * ids, ascending (SPEC-015 §4.4, sync-protocol §7).
 *
 * With `childrenFirst`, the lock orders by `(<column> IS NULL, id)` and `deletes` keeps the order
 * it is given (the lock's), so every child is deleted in a chunk before or with its parent's.
 */
export function deleteWhereStatements(
  db: NodePgDatabase,
  table: ModelTable<ModelName>,
  column: PgColumn,
  values: Iterable<string>,
  { childrenFirst, chunkSize = SYNC_LOG_CHUNK }: DeleteOrder = {},
) {
  const select = db
    .select({ id: table.id })
    .from(table)
    .where(anyOf(column, ascendingIds(values)));
  return {
    lock: (childrenFirst === undefined
      ? select.orderBy(asc(table.id))
      : select.orderBy(sql`${childrenFirst} IS NULL`, asc(table.id))
    ).for('update'),
    deletes: (ids: Iterable<string>) =>
      chunked(
        childrenFirst === undefined ? ascendingIds(ids) : [...ids].map((id) => id.toLowerCase()),
        chunkSize,
      ).map((chunk) => ({
        ids: chunk,
        delete: db
          .delete(table)
          .where(anyOf(table.id, chunk))
          .returning({ id: table.id, groups: table.syncGroups }),
      })),
  };
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

/** The key of a row in the repo's set of removed rows. */
export function removedKey(model: string, id: string): string {
  return `${model}\u0000${id.toLowerCase()}`;
}

/**
 * The assertion `flush` runs before it logs anything (ADR-0022, SPEC-011 §5.1): every unlogged
 * content delete names parents whose own row is deleted, with a logged `D`, in the same
 * transaction. `removed` holds the rows the transaction really deleted (`repo.purge`, a logged
 * `repo.deleteWhere`) and didn't write again after: a group change's `D`+`U` pair is not a delete.
 * Returns the first problem.
 */
export function unloggedDeleteProblem(
  unlogged: readonly UnloggedDelete[],
  removed: ReadonlySet<string>,
  shapeOf: (model: string) => ModelShape | undefined,
): string | undefined {
  for (const entry of unlogged) {
    const found = unloggedParent(entry.model, shapeOf(entry.model), entry.field);
    if ('problem' in found) return found.problem;
    const { parent } = found;
    const kept = entry.parentIds.find((id) => !removed.has(removedKey(parent.model, id)));
    if (kept !== undefined) {
      return `deleteWhere(${entry.model}, { log: false }) refused: parent ${parent.model} ${kept} is not deleted with a logged D in this transaction (ADR-0022).`;
    }
  }
  return undefined;
}

/**
 * The assertion `flush` runs with the unlogged-delete rule (SPEC-011 §5.1, §5.3 step 5): when a
 * transaction creates a parent (an Issue `I`) and writes content rows of it, the parent's `I`
 * comes first. A client marks an issue hydrated on its `I` packet, so content logged before it
 * would be dropped as the content of an unhydrated parent. Content deletes carry no row, so they
 * can't name a parent and are not checked. Returns the first problem.
 */
export function contentOrderProblem(
  changes: readonly {
    readonly action: string;
    readonly model: string;
    readonly id: string;
    readonly row?: Readonly<Record<string, unknown>>;
  }[],
  shapeOf: (model: string) => ModelShape | undefined,
): string | undefined {
  const created = new Map<string, number>();
  changes.forEach((change, index) => {
    const key = removedKey(change.model, change.id);
    if (change.action === 'I' && !created.has(key)) created.set(key, index);
  });
  for (const [index, change] of changes.entries()) {
    const parent = shapeOf(change.model)?.parent;
    if (parent === undefined || change.row === undefined) continue;
    const parentId = change.row[parent.field];
    if (typeof parentId !== 'string') continue;
    const at = created.get(removedKey(parent.model, parentId));
    if (at !== undefined && at > index) {
      return `${change.model} ${change.id} is logged before its parent ${parent.model} ${parentId} is created. Insert the ${parent.model} first (SPEC-011 §5.1).`;
    }
  }
  return undefined;
}
