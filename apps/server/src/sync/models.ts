/**
 * Synced models the repo layer may write, with how each computes its sync groups
 * (permissions.md §2). `sync/registry.ts` builds the sync registry (bootstrap, schema hash) from
 * it.
 */
import { teamGroup, userGroup, WORKSPACE_GROUP } from '@surface/domain';
import {
  DebugItem,
  Label,
  Team,
  TeamMembership,
  User,
  UserPreferences,
  WorkflowStatus,
  Workspace,
  type ModelDef,
} from '@surface/domain/model';
import { eq, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  debugItems,
  labels,
  teamMemberships,
  teams,
  userPreferences,
  users,
  workflowStatuses,
  workspace,
} from '../db/schema/index.js';

/**
 * What `groupsOf` receives: insert values or a full row. The repo calls it through a union of
 * models, so every model's `groupsOf` takes this and reads the fields it needs with a check.
 */
type AnyRow = Readonly<Record<string, unknown>>;

function stringField(row: AnyRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

const workspaceWide = (): readonly string[] => [WORKSPACE_GROUP];

/** A team's groups: `workspace` while public, `team:<id>` once private (permissions.md §2). */
function teamGroups(team: { readonly id: string; readonly private?: unknown }): string[] {
  return team.private === true ? [teamGroup(team.id)] : [WORKSPACE_GROUP];
}

/** A row's groups from its `teamId`; none (nobody sees it) if the field is missing. */
function groupsOfTeamRow(row: AnyRow, tx: NodePgDatabase): readonly string[] | Promise<string[]> {
  const teamId = stringField(row, 'teamId');
  return teamId === undefined ? [] : groupsOfTeam(teamId, tx);
}

/**
 * Groups of a row that belongs to a team: the team's own (permissions.md §2, children inherit).
 * Read in the row's transaction, so a team inserted earlier in it counts. A missing team gets no
 * groups, so nobody sees the row, and its foreign key fails the transaction anyway.
 */
async function groupsOfTeam(teamId: string, tx: NodePgDatabase): Promise<string[]> {
  const [team] = await tx
    .select({ id: teams.id, private: teams.private })
    .from(teams)
    .where(eq(teams.id, teamId))
    // Mutations run READ COMMITTED: without the lock, a child written while the team turns
    // private could keep the old `workspace` groups. FOR SHARE waits for that update.
    .for('share');
  return team ? teamGroups(team) : [];
}

export const SYNCED_MODELS = {
  DebugItem: {
    table: debugItems,
    /** The shared definition the client holds (`@surface/domain/model`); see `sync/registry.ts`. */
    def: DebugItem,
    /** Engine fixture (PLAN-002 header): left out of the production registry and schema hash. */
    fixture: true,
    /**
     * Who may see a row (permissions.md §2), from the row and, for models whose groups derive
     * from another row (an issue's team), the transaction. Debug items carry their groups as
     * data, so tests can put them anywhere; none given, nobody sees the row.
     */
    groupsOf: (
      row: { readonly syncGroups?: readonly string[] },
      _tx: NodePgDatabase,
    ): readonly string[] | Promise<readonly string[]> => row.syncGroups ?? [],
    /**
     * The fields `groupsOf` reads. `repo.updateWhere` keeps each row's stored groups, so it
     * refuses a patch that sets one of them (SPEC-011 §5.1); `repo.update` recomputes the groups.
     */
    groupFields: ['syncGroups'],
    /**
     * The column naming the row's team (the team's own `id` for Team), or `null` for
     * workspace-wide models. Reads by a key limited to some teams filter on it in SQL,
     * because public teams share the `workspace` group (permissions.md §3.5, §5 item 8).
     * Every model must state it; PLAN-001 S1 adds the first team-owned ones.
     */
    teamColumn: null,
  },
  // PLAN-001 S1 (SPEC-001 §5). M0 has no private teams yet, but the groups are ready for them.
  Workspace: {
    table: workspace,
    def: Workspace,
    fixture: false,
    groupsOf: workspaceWide,
    groupFields: [],
    teamColumn: null,
  },
  User: {
    table: users,
    def: User,
    fixture: false,
    groupsOf: workspaceWide,
    groupFields: [],
    teamColumn: null,
  },
  UserPreferences: {
    table: userPreferences,
    def: UserPreferences,
    fixture: false,
    /** The row's id is its user's id: only that user sees it. */
    groupsOf: (row: AnyRow): readonly string[] => {
      const id = stringField(row, 'id');
      return id === undefined ? [] : [userGroup(id)];
    },
    groupFields: ['id'],
    teamColumn: null,
  },
  Team: {
    table: teams,
    def: Team,
    fixture: false,
    groupsOf: (row: AnyRow): readonly string[] => {
      const id = stringField(row, 'id');
      return id === undefined ? [] : teamGroups({ id, private: row.private });
    },
    groupFields: ['id', 'private'],
    teamColumn: teams.id,
  },
  TeamMembership: {
    table: teamMemberships,
    def: TeamMembership,
    fixture: false,
    groupsOf: groupsOfTeamRow,
    groupFields: ['teamId'],
    teamColumn: teamMemberships.teamId,
  },
  WorkflowStatus: {
    table: workflowStatuses,
    def: WorkflowStatus,
    fixture: false,
    groupsOf: groupsOfTeamRow,
    groupFields: ['teamId'],
    teamColumn: workflowStatuses.teamId,
  },
  Label: {
    table: labels,
    def: Label,
    fixture: false,
    /** A workspace label (no team) is workspace-wide; a team label has its team's groups. */
    groupsOf: (row: AnyRow, tx: NodePgDatabase): readonly string[] | Promise<string[]> =>
      row.teamId === null || row.teamId === undefined
        ? [WORKSPACE_GROUP]
        : groupsOfTeamRow(row, tx),
    groupFields: ['teamId'],
    teamColumn: labels.teamId,
  },
} as const satisfies Record<
  string,
  {
    readonly def: ModelDef;
    readonly fixture: boolean;
    readonly groupFields: readonly string[];
    readonly teamColumn: PgColumn | null;
    readonly [other: string]: unknown;
  }
>;

export type ModelName = keyof typeof SYNCED_MODELS;
export type ModelTable<M extends ModelName> = (typeof SYNCED_MODELS)[M]['table'];
/** A full row as the repo returns it. */
export type ModelRow<M extends ModelName> = ModelTable<M>['$inferSelect'];
/**
 * Columns a handler supplies on insert. `syncGroups` is optional: the repo always overwrites it
 * with `groupsOf(row)`, so only the DebugItem fixture, whose groups are data, reads it.
 */
export type ModelInsert<M extends ModelName> = Omit<ModelTable<M>['$inferInsert'], 'syncGroups'> & {
  readonly syncGroups?: readonly string[];
};
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
