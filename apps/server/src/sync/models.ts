/**
 * Synced models the repo layer may write, with how each computes its sync groups
 * (permissions.md §2). `sync/registry.ts` builds the sync registry (bootstrap, schema hash) from
 * it.
 */
import { teamGroup, userGroup, WORKSPACE_GROUP } from '@surface/domain';
import {
  Attachment,
  Comment,
  DebugItem,
  Draft,
  Issue,
  IssueContent,
  IssueHistory,
  Label,
  Reaction,
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
  attachments,
  comments,
  debugItems,
  issueContent,
  issueHistory,
  drafts,
  issues,
  labels,
  reactions,
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
 * An Issue's groups from its team's privacy and its people (SPEC-011 §5.7, permissions.md §2): a
 * private team's issue is in `team:<teamId>` only; a public team's issue also in
 * `user:<creatorId>` and, when assigned, `user:<assigneeId>`, so "My issues" is local for everyone.
 * Child rows never get the `user:` groups (`groupsOfIssueChild`).
 *
 * Every issue has a creator (SPEC-011 §4.1, `issues.creator_id NOT NULL`), and the update path
 * tells a public issue by its stored `user:<creatorId>` group (`issueGroupsOnUpdate`), so an Issue
 * row without one fails loudly here rather than getting groups that path would misread.
 */
export function issueGroups(
  row: AnyRow,
  team: { readonly id: string; readonly private: boolean },
): string[] {
  const creatorId = stringField(row, 'creatorId');
  if (creatorId === undefined) {
    throw new Error(
      'An Issue needs a creatorId: its groups (SPEC-011 §5.7) and their update rule depend on it.',
    );
  }
  if (team.private) return [teamGroup(team.id)];
  const groups = [teamGroup(team.id), userGroup(creatorId)];
  const assigneeId = stringField(row, 'assigneeId');
  if (assigneeId !== undefined && assigneeId !== creatorId) groups.push(userGroup(assigneeId));
  return groups;
}

/**
 * An Issue's groups on insert, or on a team move (M3): its team's privacy, read with the team
 * row `FOR SHARE` (SPEC-011 §4.8: `issue.create` takes the team row first). A missing team gives
 * no groups; the foreign key fails the transaction anyway.
 */
async function groupsOfIssue(row: AnyRow, tx: NodePgDatabase): Promise<string[]> {
  const teamId = stringField(row, 'teamId');
  if (teamId === undefined) return [];
  const [team] = await tx
    .select({ id: teams.id, private: teams.private })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for('share');
  return team ? issueGroups(row, team) : [];
}

/**
 * An Issue's groups after an update, from the row the handler locked and nothing else (SPEC-011
 * §4.8): `row` is that row with the patch applied, `before` its stored groups and team. The team's
 * privacy is read from the stored groups: a public team's issue always carries
 * `user:<creatorId>`, a private team's never does. So an assignee change recomputes the `user:`
 * part without reading the team row after the issue lock, and the repo logs `D` with the old
 * groups, then `U` with the new ones (sync-protocol §6). A patch that moves the issue to another
 * team (M3) returns `undefined`: the repo then reads the new team (`groupsOfIssue`).
 *
 * Stored groups without `team:<teamId>` are from before PLAN-011 S4b (`workspace`): refused
 * loudly, since guessing could put a private team's issue in a `user:` group. Development
 * databases from S3–S4 are recreated; nothing was released with them.
 */
export function issueGroupsOnUpdate(
  row: AnyRow,
  before: LockedGroups,
  patch: AnyRow,
): readonly string[] | undefined {
  const teamId = patch['teamId'];
  if (teamId !== undefined && teamId !== before.teamId) return undefined;
  const stored = stringField(row, 'teamId');
  if (stored === undefined || !before.groups.includes(teamGroup(stored))) {
    throw new Error(
      `Issue ${String(row['id'])} has groups from before partial issue loading (PLAN-011 S4b). Recreate the development database.`,
    );
  }
  const creatorId = stringField(row, 'creatorId');
  const isPublic = creatorId !== undefined && before.groups.includes(userGroup(creatorId));
  return issueGroups(row, { id: stored, private: !isPublic });
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
  // PLAN-011 S3 (SPEC-011 §4.1, §5.1); groups from S4b (§5.7).
  Issue: {
    table: issues,
    def: Issue,
    fixture: false,
    /** On insert: `issueGroups`, with the team row `FOR SHARE` (§4.8 `issue.create` lock order). */
    groupsOf: groupsOfIssue,
    /**
     * On update (`repo.update`, `archive`, `unarchive`): the groups from the locked row, or
     * `undefined` to recompute with `groupsOf`. Only Issue declares it.
     */
    groupsOnUpdate: issueGroupsOnUpdate,
    groupFields: ['teamId', 'creatorId', 'assigneeId'],
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
  // PLAN-012 S5 (SPEC-012 §4.3): only its owner sees a draft. The groups come from `userId`
  // alone, never from the team or issue it names, so a draft says nothing to anyone else.
  Draft: {
    table: drafts,
    def: Draft,
    fixture: false,
    groupsOf: (row: AnyRow): readonly string[] => {
      const userId = stringField(row, 'userId');
      return userId === undefined ? [] : [userGroup(userId)];
    },
    groupFields: ['userId'],
    teamColumn: null,
  },
  // PLAN-013 S3 (SPEC-013 §5.1): content models with parent Issue. Their groups are
  // `team:<teamId>` only, never the issue's `user:` groups (SPEC-013 D12).
  Comment: {
    table: comments,
    def: Comment,
    fixture: false,
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
    teamColumn: comments.teamId,
  },
  Reaction: {
    table: reactions,
    def: Reaction,
    fixture: false,
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
    teamColumn: reactions.teamId,
  },
  // PLAN-014 S4a (SPEC-014 §4.1, §5): an eager issue child. `team:<teamId>` only, never the
  // issue's `user:` groups, with `teamId` from the issue row; the client drops an issue's rows with
  // it (`EAGER_ISSUE_CHILDREN`), and bootstrap leaves out those of archived and deleted issues.
  Attachment: {
    table: attachments,
    def: Attachment,
    fixture: false,
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
    teamColumn: attachments.teamId,
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
