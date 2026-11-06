/**
 * Synced models the repo layer may write, with how each computes its sync groups
 * (permissions.md §2). PLAN-002 S2 extends this into the sync registry; PLAN-001 S1 adds the
 * workspace, user and team models.
 */
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { debugItems } from '../db/schema/index.js';

export const SYNCED_MODELS = {
  DebugItem: {
    table: debugItems,
    /**
     * Who may see a row (permissions.md §2), from the row and, for models whose groups derive
     * from another row (an issue's team), the transaction. Debug items carry their groups as
     * data, so tests can put them anywhere.
     */
    groupsOf: (
      row: { readonly syncGroups: readonly string[] },
      _tx: NodePgDatabase,
    ): readonly string[] | Promise<readonly string[]> => row.syncGroups,
    /**
     * The column naming the row's team (the team's own `id` for Team), or `null` for
     * workspace-wide models. Reads by a key limited to some teams filter on it in SQL,
     * because public teams share the `workspace` group (permissions.md §3.5, §5 item 8).
     * Every model must state it; PLAN-001 S1 adds the first team-owned ones.
     */
    teamColumn: null,
  },
} as const satisfies Record<
  string,
  { readonly teamColumn: PgColumn | null; readonly [other: string]: unknown }
>;

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

/** Models with an `archivedAt` column, which `repo.archive` and `repo.unarchive` set. */
export type ArchivableModel = {
  [M in ModelName]: 'archivedAt' extends keyof ModelRow<M> ? M : never;
}[ModelName];

export function isModelName(value: string): value is ModelName {
  return Object.hasOwn(SYNCED_MODELS, value);
}
