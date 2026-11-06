/**
 * Synced models the repo layer may write, with how each computes its sync groups
 * (permissions.md §2). PLAN-002 S2 extends this into the sync registry; PLAN-001 S1 adds the
 * workspace, user and team models.
 */
import type { SQL } from 'drizzle-orm';
import { debugItems } from '../db/schema/index.js';

export const SYNCED_MODELS = {
  DebugItem: {
    table: debugItems,
    /** Debug items carry their groups as data, so tests can put them anywhere. */
    groupsOf: (row: { syncGroups: string[] }): string[] => row.syncGroups,
  },
} as const;

export type ModelName = keyof typeof SYNCED_MODELS;
export type ModelTable<M extends ModelName> = (typeof SYNCED_MODELS)[M]['table'];
/** A full row as the repo returns it. */
export type ModelRow<M extends ModelName> = ModelTable<M>['$inferSelect'];
/** Columns a handler supplies on insert. The repo overwrites `syncGroups` with `groupsOf(row)`. */
export type ModelInsert<M extends ModelName> = ModelTable<M>['$inferInsert'];
/**
 * Columns a handler may change; the id and timestamps are the repo's. A value may be a SQL
 * expression (`sql\`${t.counter} + 1\``) for updates that must not lose concurrent writes.
 */
export type ModelPatch<M extends ModelName> = {
  [K in Exclude<keyof ModelTable<M>['$inferInsert'], 'id' | 'createdAt' | 'updatedAt'>]?:
    ModelTable<M>['$inferInsert'][K] | SQL;
};

export function isModelName(value: string): value is ModelName {
  return Object.hasOwn(SYNCED_MODELS, value);
}
