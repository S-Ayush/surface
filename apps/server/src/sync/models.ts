/**
 * Synced models the repo layer may write, with how each computes its sync groups
 * (permissions.md §2). `sync/registry.ts` builds the sync registry (bootstrap, schema hash) from
 * it.
 */
import { teamGroup, userGroup, WORKSPACE_GROUP } from '@surface/domain';
import {
  DebugItem,
  Issue,
  IssueContent,
  IssueHistory,
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
  issueContent,
  issueHistory,
  issues,
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

/**
 * The groups of an issue's child row (IssueContent, IssueHistory, and SPEC-013/014's Comment,
 * Reaction, Attachment): `team:<teamId>` only, never the issue's `user:` groups (SPEC-011 §5.1,
 * §5.7). Reads no row: the repo sets a child's `teamId` from its issue's row before calling it
 * (`issueChildTeam`), so it never trusts a `teamId` from input. No team id, no groups.
 */
export function groupsOfIssueChild(row: AnyRow): readonly string[] {
  const teamId = stringField(row, 'teamId');
  return teamId === undefined ? [] : [teamGroup(teamId)];
}

/**
 * The team of the issue `issueId` names, from the issue row (SPEC-011 §5.1, D4): what the repo
 * stores as an issue child's `teamId`, whatever the handler passed. The handler has locked the
 * issue already (`lockIssueForWrite`), so this takes no lock and reads no team row (§4.8). A
 * missing issue gives `undefined`: the child then gets no groups, and its foreign key fails the
 * transaction anyway.
 */
export async function issueChildTeam(row: AnyRow, tx: NodePgDatabase): Promise<string | undefined> {
  const issueId = stringField(row, 'issueId');
  if (issueId === undefined) return undefined;
  const [issue] = await tx
    .select({ teamId: issues.teamId })
    .from(issues)
    .where(eq(issues.id, issueId));
  return issue?.teamId;
}

/** What `change()` read from the row it locked, before the update. */
export interface LockedGroups {
  readonly groups: readonly string[];
  readonly teamId: unknown;
}

/**
 * An Issue's groups after an update, from the row the handler locked (SPEC-011 §4.8): its stored
 * groups, unless the patch moves it to another team (M3), when `groupsOf` reads the new team.
 * A patch naming the issue's own team is no move. So an issue edit never reads a team row after
 * the issue lock. In S3 and S4 they are the team's groups, which only a team move changes; S4b
 * replaces this with SPEC-011 §5.7's builder (still reading no team row: it tells a public
 * team's issue by the stored `user:<creatorId>` group).
 */
function issueGroupsOnUpdate(
  _row: AnyRow,
  before: LockedGroups,
  patch: AnyRow,
): readonly string[] | undefined {
  const teamId = patch['teamId'];
  return teamId === undefined || teamId === before.teamId ? before.groups : undefined;
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
  // PLAN-011 S3 (SPEC-011 §4.1, §5.1). Public team issues are in `workspace` until S4b.
  Issue: {
    table: issues,
    def: Issue,
    fixture: false,
    /** On insert: the team's groups, read `FOR SHARE` (§4.8 `issue.create` lock order). */
    groupsOf: groupsOfTeamRow,
    /**
     * On update (`repo.update`, `archive`, `unarchive`): the groups from the locked row, or
     * `undefined` to recompute with `groupsOf`. Only Issue declares it.
     */
    groupsOnUpdate: issueGroupsOnUpdate,
    groupFields: ['teamId'],
    teamColumn: issues.teamId,
  },
  // PLAN-011 S5a (SPEC-011 §5.1): content models, loaded per issue (`sync/content.ts`). Their
  // `teamId` and groups come from the issue row (`issueChild`); nothing writes them before S6.
  IssueContent: {
    table: issueContent,
    def: IssueContent,
    fixture: false,
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
    teamColumn: issueContent.teamId,
  },
  IssueHistory: {
    table: issueHistory,
    def: IssueHistory,
    fixture: false,
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
    teamColumn: issueHistory.teamId,
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

/**
 * Whether `model` is an issue child (SPEC-011 §5.1): its entry declares `issueChild: true` with
 * `groupsOf: groupsOfIssueChild` and `groupFields: ['issueId', 'teamId']` (`issueChildProblem`
 * in `registry.ts` checks all three at startup). The repo then stores the issue's team as the
 * row's `teamId` on insert, never writes one from a patch, and refuses a patch of `issueId`.
 * IssueContent and IssueHistory are the first (PLAN-011 S5a).
 */
export function isIssueChild(model: ModelName): boolean {
  const entry: Readonly<Record<string, unknown>> = SYNCED_MODELS[model];
  return entry['issueChild'] === true;
}
