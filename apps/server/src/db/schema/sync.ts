import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The change log every client syncs from (SPEC-002 §4.1, sync-protocol §3). Only the repo
 * layer writes it, under `pg_advisory_xact_lock(LOCKS.sync)` held until commit, so `sync_id`
 * is gap-free and in commit order.
 */
export const syncLog = pgTable(
  'sync_log',
  {
    syncId: bigint({ mode: 'number' }).primaryKey(),
    model: text().notNull(),
    modelId: uuid().notNull(),
    /** I insert, U update, A archive, V unarchive, D delete (or no longer visible to `groups`). */
    action: char({ length: 1 }).notNull(),
    /** The full row for I, U, A and V; null for D. */
    data: jsonb(),
    /** Who may see this change: rows reach a client only when `groups && clientGroups`. */
    groups: text().array().notNull(),
    /** The sync client that sent the mutation, for acks (SPEC-002 §4.4). */
    clientId: uuid(),
    clientSeq: bigint({ mode: 'number' }),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('sync_log_action_check', sql`${t.action} IN ('I', 'U', 'A', 'V', 'D')`),
    index('sync_log_groups_gin').using('gin', t.groups),
  ],
);

/** One row holding the last assigned sync id; migration 0005 seeds it with 0. */
export const syncState = pgTable(
  'sync_state',
  {
    id: integer().primaryKey().default(1),
    lastSyncId: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [check('sync_state_single_row', sql`${t.id} = 1`)],
);

/** Exactly-once bookkeeping per sync client (SPEC-002 §4.4); used by `/sync/mutate` (S5). */
export const clientMutations = pgTable('client_mutations', {
  clientId: uuid().primaryKey(),
  userId: uuid().notNull(),
  lastSeq: bigint({ mode: 'number' }).notNull(),
  /**
   * `[{ seq, status, … }]`: the results of the last 100 seqs (`KEPT_RESULTS`, at least the last
   * batch), returned again when they are resent.
   */
  lastResults: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
});
