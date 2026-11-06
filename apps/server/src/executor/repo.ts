/**
 * The repo layer: the only writer of synced tables (CLAUDE.md rule 2, SPEC-002 §4.2).
 * Handlers get it as `ctx.repo`, bound to the operation's transaction.
 *
 * PLAN-003 S4 ships a passthrough implementation that writes rows and buffers the changes.
 * PLAN-002 S2 replaces it with the sync-logging repo, whose `flush` appends `sync_log` rows
 * under `pg_advisory_xact_lock(LOCKS.sync)` and returns the new `lastSyncId`.
 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  SYNCED_MODELS,
  type ModelInsert,
  type ModelName,
  type ModelPatch,
  type ModelRow,
} from '../sync/models.js';
import { SurfaceError } from './errors.js';

export type RowChangeAction = 'insert' | 'update' | 'purge';

/** One buffered change, in the order the handler made it. */
export interface RowChange {
  readonly action: RowChangeAction;
  readonly model: ModelName;
  readonly id: string;
  /** The full row after the change; absent for purges. */
  readonly row?: Readonly<Record<string, unknown>>;
  readonly groups: readonly string[];
}

/** Where a mutation came from, for exactly-once bookkeeping (SPEC-002 §4.4). */
export interface ChangeOrigin {
  readonly clientId?: string;
  readonly seq?: number;
}

export interface Repo {
  /** Inserts a row and returns it. A duplicate id is `CONFLICT` (SPEC-003 E7). */
  insert<M extends ModelName>(model: M, row: ModelInsert<M>): Promise<ModelRow<M>>;
  /** Applies a patch, sets `updatedAt`, and returns the full row. A missing row is `NOT_FOUND`. */
  update<M extends ModelName>(model: M, id: string, patch: ModelPatch<M>): Promise<ModelRow<M>>;
  /** Hard delete (trash purge, INV-21). */
  purge(model: ModelName, id: string): Promise<void>;
  /** Changes buffered so far. */
  changes(): readonly RowChange[];
}

/** The executor's handle on the repo: the handler view plus the end-of-transaction flush. */
export interface TransactionRepo extends Repo {
  /** Step 11: record the buffered changes. Returns the last sync id when sync logging is on. */
  flush(origin: ChangeOrigin): Promise<{ lastSyncId?: number }>;
}

export type RepoFactory = (db: NodePgDatabase, now: Date) => TransactionRepo;

/** Writes rows and buffers changes; records nothing else (until PLAN-002 S2). */
export const passthroughRepo: RepoFactory = (db, now) => {
  const buffered: RowChange[] = [];

  return {
    async insert(model, row) {
      const { table, groupsOf } = SYNCED_MODELS[model];
      const groups = groupsOf({ syncGroups: row.syncGroups });
      const values = { ...row, syncGroups: groups, createdAt: now, updatedAt: now };
      try {
        const [inserted] = await db.insert(table).values(values).returning();
        if (!inserted) throw new Error(`insert into ${model} returned no row`);
        buffered.push({ action: 'insert', model, id: inserted.id, row: inserted, groups });
        return inserted;
      } catch (error) {
        if (isPrimaryKeyViolation(error)) {
          // SPEC-003 E7: never silently overwrite a client-supplied id.
          throw new SurfaceError('CONFLICT', `${model} id already exists. Use a new id.`);
        }
        throw error;
      }
    },

    async update(model, id, patch) {
      const { table, groupsOf } = SYNCED_MODELS[model];
      const [updated] = await db
        .update(table)
        .set({ ...patch, updatedAt: now })
        .where(eq(table.id, id))
        .returning();
      if (!updated) throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);
      buffered.push({ action: 'update', model, id, row: updated, groups: groupsOf(updated) });
      return updated;
    },

    async purge(model, id) {
      const { table, groupsOf } = SYNCED_MODELS[model];
      const [deleted] = await db.delete(table).where(eq(table.id, id)).returning();
      if (!deleted) throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);
      buffered.push({ action: 'purge', model, id, groups: groupsOf(deleted) });
    },

    changes: () => [...buffered],

    flush: () => Promise.resolve({}),
  };
};

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
