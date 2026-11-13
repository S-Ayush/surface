/**
 * The repo layer: the only writer of synced tables (CLAUDE.md rule 2, SPEC-002 §4.2).
 * Handlers get it as `ctx.repo`, bound to the operation's transaction. Every write is buffered
 * as a change; at the end of the transaction the executor calls `flush`, which appends the
 * changes to `sync_log` under `pg_advisory_xact_lock(LOCKS.sync)`. The lock is held until
 * commit, so sync ids are gap-free and in commit order (sync-protocol §3). `flush` also
 * notifies the hub (`NOTIFY sync`), which Postgres delivers when the transaction commits.
 */
import { eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { LOCKS } from '../db/locks.js';
import { syncLog, syncState } from '../db/schema/index.js';
import { SurfaceError } from '../executor/errors.js';
import {
  chunked,
  columnOf,
  contentOrderProblem,
  deleteWhereStatements,
  patchedFields,
  removedKey,
  unloggedDeleteProblem,
  unloggedParent,
  updateWhereProblem,
  updateWhereStatements,
  type ModelShape,
  type UnloggedDelete,
} from './bulk.js';
import {
  isIssueChild,
  isModelName,
  issueChildTeam,
  SYNCED_MODELS,
  type ArchivableModel,
  type ModelInsert,
  type ModelName,
  type ModelPatch,
  type ModelRow,
} from './models.js';

export { SYNC_LOG_CHUNK } from './bulk.js';
export type { UnloggedDelete } from './bulk.js';

/** The channel the hub listens on (SPEC-002 §4.3). */
export const SYNC_CHANNEL = 'sync';

/** How long `sync_log` rows are kept for catch-up (sync-protocol §9). */
export const SYNC_LOG_RETENTION_DAYS = 30;

/** I insert, U update, A archive, V unarchive, D delete or no longer visible (SPEC-002 §4.1). */
export type SyncAction = 'I' | 'U' | 'A' | 'V' | 'D';

/** One buffered change, in the order the handler made it. */
export interface RowChange {
  readonly action: SyncAction;
  readonly model: ModelName;
  readonly id: string;
  /** The row after the change, as logged (`loggedRow`: declared fields only); absent for D. */
  readonly row?: Readonly<Record<string, unknown>>;
  /** Who may see this change. */
  readonly groups: readonly string[];
}

/** Where a mutation came from, for acks and exactly-once bookkeeping (SPEC-002 §4.4). */
export interface ChangeOrigin {
  readonly clientId?: string;
  readonly seq?: number;
}

export interface Repo {
  /** Inserts a row and returns it. A duplicate id is `CONFLICT` (SPEC-003 E7). */
  insert<M extends ModelName>(model: M, row: ModelInsert<M>): Promise<ModelRow<M>>;
  /** Applies a patch, sets `updatedAt`, and returns the full row. A missing row is `NOT_FOUND`. */
  update<M extends ModelName>(model: M, id: string, patch: ModelPatch<M>): Promise<ModelRow<M>>;
  /** Sets `archivedAt` (and `updatedAt`). */
  archive<M extends ArchivableModel>(model: M, id: string): Promise<ModelRow<M>>;
  /** Clears `archivedAt` (and sets `updatedAt`). */
  unarchive<M extends ArchivableModel>(model: M, id: string): Promise<ModelRow<M>>;
  /** Hard delete (trash purge, INV-21). */
  purge(model: ModelName, id: string): Promise<void>;
  /**
   * Bulk update (SPEC-011 §5.1), for cascades: locks the rows in ascending id, updates them in
   * chunks and logs one `U` per row with its **stored** groups, so it reads no other row (no team
   * read after an issue lock, SPEC-011 §4.8). It refuses a patch that touches a field the groups
   * derive from (`teamId`). `updatedAt` is set only with `touchUpdatedAt` (cascades pass false).
   * An empty patch writes nothing and logs each row again, as stored. Ids with no row are
   * skipped. Returns the ids of the rows it logged, in ascending order.
   */
  updateWhere<M extends ModelName>(
    model: M,
    ids: readonly string[],
    patch: ModelPatch<M>,
    options: { readonly touchUpdatedAt: boolean },
  ): Promise<string[]>;
  /**
   * Bulk delete (SPEC-011 §5.1): deletes the rows whose `field` (a uuid column) is one of `ids`,
   * in chunks, and logs one `D` per row. Returns the deleted ids in ascending order.
   *
   * `log: false` logs nothing: the one unlogged repo write (ADR-0022), for purging an issue's
   * content. It is refused unless `model` is a content model matched on its parent field, and
   * `flush` fails the transaction unless each parent is deleted, with a logged `D`, in it too.
   */
  deleteWhere<M extends ModelName>(
    model: M,
    field: keyof ModelRow<M> & string,
    ids: readonly string[],
    options?: { readonly log?: boolean },
  ): Promise<string[]>;
  /** Changes buffered so far. */
  changes(): readonly RowChange[];
}

export interface Flushed {
  /** The last sync id this transaction appended; absent when nothing changed. */
  readonly lastSyncId?: number;
  /** `performance.now()` when the sync lock was taken: the hold lasts until commit. */
  readonly lockedAt?: number;
}

/** The executor's handle on the repo: the handler view plus the end-of-transaction flush. */
export interface TransactionRepo extends Repo {
  /**
   * Step 11: appends the buffered changes to `sync_log`, in chunks of `SYNC_LOG_CHUNK` rows under
   * one lock and one `sync_state` bump. Takes no lock when nothing changed. First asserts the
   * unlogged-delete rule (ADR-0022) and that a parent created here is logged before its content
   * rows (SPEC-011 §5.1), and throws if either is broken.
   */
  flush(origin: ChangeOrigin): Promise<Flushed>;
  /** The `deleteWhere(…, { log: false })` calls so far, for the test write audit (SPEC-002 AC-12). */
  unloggedDeletes(): readonly UnloggedDelete[];
}

/** A synced model's load strategy and, for a content model, its parent (`defineModel`). */
export function modelShape(model: string): ModelShape | undefined {
  if (!isModelName(model)) return undefined;
  const { def } = SYNCED_MODELS[model];
  return { load: def.load, ...(def.parent === undefined ? {} : { parent: def.parent }) };
}

export type RepoFactory = (db: NodePgDatabase, now: Date) => TransactionRepo;

/** Test seams of `syncRepo`. Production code passes none. */
export interface SyncRepoOptions {
  /**
   * Each model's load strategy and content parent. Default `modelShape`. Tests pass stand-in
   * content models over tables their scripted connection holds.
   */
  readonly shapeOf?: (model: string) => ModelShape | undefined;
}

export function syncRepo(
  db: NodePgDatabase,
  now: Date,
  { shapeOf = modelShape }: SyncRepoOptions = {},
): TransactionRepo {
  const buffered: RowChange[] = [];
  const unlogged: UnloggedDelete[] = [];
  /**
   * Rows this transaction really deleted (`purge`, a logged `deleteWhere`), and has not written
   * since: the parents an unlogged content delete may name (ADR-0022). A group change's `D` is
   * not a delete, so it never adds one; any later `I`, `U`, `A` or `V` of the row removes it.
   */
  const removed = new Set<string>();
  const push = (change: RowChange) => {
    buffered.push(change);
    if (change.action !== 'D') removed.delete(removedKey(change.model, change.id));
  };
  const pushRemoved = (model: ModelName, id: string, groups: readonly string[]) => {
    push({ action: 'D', model, id, groups });
    removed.add(removedKey(model, id));
  };

  /** Writes and logs a row whose groups may have changed (update, archive, unarchive). */
  async function change<M extends ModelName>(
    model: M,
    id: string,
    action: 'U' | 'A' | 'V',
    patch: Record<string, unknown>,
  ): Promise<ModelRow<M>> {
    const entry = SYNCED_MODELS[model];
    const { table, groupsOf } = entry;
    // SPEC-011 §5.1: an issue child's `teamId` is its issue's, set on insert; a patch never moves
    // it. A new `issueId` would put the row under another team's issue with the old team's
    // groups, so that is a bug in the handler, refused before anything is read or written.
    const child = isIssueChild(model);
    if (child && patchedFields(patch).includes('issueId')) {
      throw new Error(
        `${model} can't move to another issue: its team and groups come from its issue (SPEC-011 §5.1).`,
      );
    }
    const { teamId: _childTeam, ...childPatch } = patch;
    const values = child ? childPatch : patch;
    // The groups before the change, and the row lock, in one read; for a model that keeps its
    // groups on update (Issue), its team too, so a patch naming the same team reads no team row.
    const [before] = await db
      .select({
        groups: table.syncGroups,
        ...('groupsOnUpdate' in entry ? { teamId: entry.teamColumn } : {}),
      })
      .from(table)
      .where(eq(table.id, id))
      .for('update');
    if (!before) throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);

    let [row] = await db
      .update(table)
      .set({ ...values, updatedAt: now })
      .where(eq(table.id, id))
      .returning();
    if (!row) throw new Error(`update of ${model} ${id} returned no row`);
    // SPEC-011 §4.8: an Issue keeps the groups of the row its handler locked, so no team row is
    // read after the issue lock; other models recompute them.
    const kept =
      'groupsOnUpdate' in entry
        ? entry.groupsOnUpdate(
            row,
            {
              groups: before.groups,
              teamId: 'teamId' in before ? before.teamId : undefined,
            },
            values,
          )
        : undefined;
    const groups = kept ?? (await groupsOf(row, db));
    if (!sameSet(groups, row.syncGroups)) {
      // A change to a field the groups derive from (a team move): store the new groups.
      [row] = await db
        .update(table)
        .set({ syncGroups: [...groups] })
        .where(eq(table.id, id))
        .returning();
      if (!row) throw new Error(`update of ${model} ${id} returned no row`);
    }
    if (!sameSet(before.groups, groups)) {
      // Clients that could see the row but no longer can drop it; the ones that still or now
      // can see it get the full row next (sync-protocol §6). Consecutive ids, one transaction.
      push({ action: 'D', model, id, groups: before.groups });
    }
    push({ action, model, id, row: loggedRow(model, row), groups });
    return row;
  }

  return {
    async insert(model, values) {
      const { table, groupsOf } = SYNCED_MODELS[model];
      // SPEC-011 §5.1, D4: an issue child's `teamId` comes from its issue's row, never from input.
      const childTeam = isIssueChild(model)
        ? { teamId: (await issueChildTeam(values, db)) ?? null }
        : {};
      const groups = await groupsOf({ ...values, ...childTeam }, db);
      try {
        const [row] = await db
          .insert(table)
          .values({
            ...values,
            ...childTeam,
            syncGroups: [...groups],
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error(`insert into ${model} returned no row`);
        push({ action: 'I', model, id: row.id, row: loggedRow(model, row), groups });
        return row;
      } catch (error) {
        if (isPrimaryKeyViolation(error)) {
          // SPEC-003 E7: never silently overwrite a client-supplied id.
          throw new SurfaceError('CONFLICT', `${model} id already exists. Use a new id.`);
        }
        throw error;
      }
    },

    update: (model, id, patch) => change(model, id, 'U', patch),
    archive: (model, id) => change(model, id, 'A', { archivedAt: now }),
    unarchive: (model, id) => change(model, id, 'V', { archivedAt: null }),

    async purge(model, id) {
      const { table } = SYNCED_MODELS[model];
      const [deleted] = await db
        .delete(table)
        .where(eq(table.id, id))
        .returning({ groups: table.syncGroups });
      if (!deleted) throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);
      pushRemoved(model, id, deleted.groups);
    },

    async updateWhere(model, ids, patch, { touchUpdatedAt }) {
      const problem = updateWhereProblem(model, patch);
      if (problem !== undefined) throw new Error(problem);
      const { table } = SYNCED_MODELS[model];
      const statements = updateWhereStatements(db, table, ids, patch, { touchUpdatedAt, now });
      const rows: { readonly id: string; readonly syncGroups: string[] }[] = [];
      for (const chunk of statements) {
        const locked = await chunk.lock;
        if (chunk.update === undefined) {
          rows.push(...locked);
          continue;
        }
        // RETURNING follows no order: sort, so the log is in id order like the locks.
        const updated = await chunk.update;
        rows.push(...updated.sort(byId));
      }
      for (const row of rows) {
        push({
          action: 'U',
          model,
          id: row.id,
          row: loggedRow(model, row),
          groups: row.syncGroups,
        });
      }
      return rows.map((row) => row.id);
    },

    async deleteWhere(model, field, ids, options = {}) {
      const log = options.log ?? true;
      const { table } = SYNCED_MODELS[model];
      const found = columnOf(table, field);
      if ('problem' in found) throw new Error(`deleteWhere(${model}): ${model} ${found.problem}`);
      if (!log) {
        const allowed = unloggedParent(model, shapeOf(model), field);
        if ('problem' in allowed) throw new Error(allowed.problem);
      }
      const statements = deleteWhereStatements(db, table, found.column, ids);
      const locked = await statements.lock;
      const deleted: { id: string; groups: string[] }[] = [];
      for (const chunk of statements.deletes(locked.map((row) => row.id))) {
        deleted.push(...(await chunk.delete));
      }
      deleted.sort(byId);
      if (log) {
        for (const row of deleted) pushRemoved(model, row.id, row.groups);
      } else {
        unlogged.push({
          model,
          field,
          parentIds: [...new Set(ids.map((id) => id.toLowerCase()))],
          ids: deleted.map((row) => row.id),
        });
      }
      return deleted.map((row) => row.id);
    },

    changes: () => [...buffered],
    unloggedDeletes: () => [...unlogged],

    async flush(origin) {
      // ADR-0022: the content deletes that logged nothing must sit next to their parent's `D`.
      const problem =
        unloggedDeleteProblem(unlogged, removed, shapeOf) ??
        // SPEC-011 §5.1, §5.3 step 5: a created Issue is logged before its content rows, so the
        // Issue's `I` packet may mark it hydrated on every client that receives it.
        contentOrderProblem(buffered, shapeOf);
      if (problem !== undefined) throw new Error(problem);
      if (buffered.length === 0) return {};
      await db.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS.sync}::bigint)`);
      const lockedAt = performance.now();
      const [state] = await db
        .update(syncState)
        .set({ lastSyncId: sql`${syncState.lastSyncId} + ${buffered.length}` })
        .where(eq(syncState.id, 1))
        // The hub's notification rides on this statement (no extra round trip under the lock).
        // Postgres sends it at commit, and not at all on rollback, so the hub never reads ahead
        // of the log.
        .returning({
          lastSyncId: syncState.lastSyncId,
          notified: sql`pg_notify(${SYNC_CHANNEL}, ${syncState.lastSyncId}::text)`,
        });
      if (!state) throw new Error('sync_state has no row. Migration 0005 seeds it');
      const first = state.lastSyncId - buffered.length + 1;
      const rows = buffered.map((c, i) => ({
        syncId: first + i,
        model: c.model,
        modelId: c.id,
        action: c.action,
        data: c.row ?? null,
        groups: [...c.groups],
        clientId: origin.clientId ?? null,
        clientSeq: origin.seq ?? null,
      }));
      // Chunks keep each statement under Postgres's 65,535 bind parameters (SPEC-011 §5.1).
      for (const chunk of chunked(rows)) await db.insert(syncLog).values(chunk);
      return { lastSyncId: state.lastSyncId, lockedAt };
    },
  };
}

/**
 * Deletes `sync_log` rows older than `before`, except the newest, which the hub's retention check
 * needs: the oldest row left says how far back catch-up reaches (SPEC-002 §4.3). Run daily by the
 * `synclog-prune` job. Not a synced-table write in the AC-12 sense: no row is changed, only
 * history no client may ask for any more.
 */
export async function pruneSyncLog(db: NodePgDatabase, before: Date): Promise<number> {
  // A prefix of the log, never rows in between: `created_at` is taken before the sync lock, so it
  // is not quite in id order, and a hole would let catch-up skip rows that `min(sync_id)` says it
  // still has. Up to the first row young enough to keep (LEAST ignores a NULL), and never the
  // newest row, whose id tells the hub how far catch-up reaches.
  const result = await db.delete(syncLog).where(
    lt(
      syncLog.syncId,
      sql`LEAST(
        (SELECT min(sync_id) FROM sync_log WHERE created_at >= ${before.toISOString()}::timestamptz),
        (SELECT last_sync_id FROM sync_state WHERE id = 1)
      )`,
    ),
  );
  return result.rowCount ?? 0;
}

/** Columns every synced row may carry besides its model's fields (SPEC-002 §4.1). */
const BOOKKEEPING = ['id', 'syncGroups', 'archivedAt'] as const;

/**
 * The row a change logs (`RowChange.row`, then `sync_log.data`): the model's declared fields, the
 * id and the sync bookkeeping, nothing else. Synced tables hold no undeclared column today
 * (`workspace-models.test.ts`, PLAN-001 S1); this keeps the next one, a secret or a counter, out
 * of the log even if it slips into a synced table. The handler still gets the full row.
 */
export function loggedRow(
  model: ModelName,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const fields = SYNCED_MODELS[model].def.fields;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (Object.hasOwn(fields, field) || BOOKKEEPING.some((kept) => kept === field)) {
      out[field] = value;
    }
  }
  return out;
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((g) => set.has(g));
}

/** Postgres `unique_violation` on a `*_pkey` constraint, possibly wrapped by Drizzle. */
function isPrimaryKeyViolation(error: unknown): boolean {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = Reflect.get(e, 'cause')) {
    const code: unknown = Reflect.get(e, 'code');
    const constraint: unknown = Reflect.get(e, 'constraint');
    if (code === '23505' && typeof constraint === 'string' && constraint.endsWith('_pkey')) {
      return true;
    }
  }
  return false;
}
