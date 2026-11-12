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
  SYNCED_MODELS,
  type ArchivableModel,
  type ModelInsert,
  type ModelName,
  type ModelPatch,
  type ModelRow,
} from './models.js';

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
  /** Step 11: appends the buffered changes to `sync_log`. Takes no lock when nothing changed. */
  flush(origin: ChangeOrigin): Promise<Flushed>;
}

export type RepoFactory = (db: NodePgDatabase, now: Date) => TransactionRepo;

export const syncRepo: RepoFactory = (db, now) => {
  const buffered: RowChange[] = [];
  const push = (change: RowChange) => void buffered.push(change);

  /** Writes and logs a row whose groups may have changed (update, archive, unarchive). */
  async function change<M extends ModelName>(
    model: M,
    id: string,
    action: 'U' | 'A' | 'V',
    values: Record<string, unknown>,
  ): Promise<ModelRow<M>> {
    const { table, groupsOf } = SYNCED_MODELS[model];
    // The groups before the change, and the row lock, in one read.
    const [before] = await db
      .select({ groups: table.syncGroups })
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
    const groups = await groupsOf(row, db);
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
      const groups = await groupsOf(values, db);
      try {
        const [row] = await db
          .insert(table)
          .values({ ...values, syncGroups: [...groups], createdAt: now, updatedAt: now })
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
      push({ action: 'D', model, id, groups: deleted.groups });
    },

    changes: () => [...buffered],

    async flush(origin) {
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
      await db.insert(syncLog).values(
        buffered.map((c, i) => ({
          syncId: first + i,
          model: c.model,
          modelId: c.id,
          action: c.action,
          data: c.row ?? null,
          groups: [...c.groups],
          clientId: origin.clientId ?? null,
          clientSeq: origin.seq ?? null,
        })),
      );
      return { lastSyncId: state.lastSyncId, lockedAt };
    },
  };
};

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
