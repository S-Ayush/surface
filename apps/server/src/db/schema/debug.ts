import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `DebugItem`: the internal fixture model the executor and sync engine are built and tested
 * against until real models exist (PLAN-002 header, PLAN-003 S4). Synced: its groups are data,
 * so tests can place items in any sync group. Only internal `debug.*` operations touch it.
 */
export const debugItems = pgTable(
  'debug_items',
  {
    id: uuid().primaryKey(),
    title: text().notNull(),
    counter: integer().notNull().default(0),
    syncGroups: text().array().notNull(),
    // Millisecond precision, like every synced instant: the replica compares what is stored
    // (SPEC-003 §7.4), and list cursors carry the exact value.
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** Set by `repo.archive`, cleared by `repo.unarchive` (PLAN-002 S2). */
    archivedAt: timestamp({ withTimezone: true, precision: 3 }),
  },
  (t) => [index('debug_items_sync_groups_idx').using('gin', t.syncGroups)],
);
