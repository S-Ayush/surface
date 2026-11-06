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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('debug_items_sync_groups_idx').using('gin', t.syncGroups)],
);
