// The composer's rules as pure functions (SPEC-012 §3.1, §3.2; PLAN-012 S5): which team it opens
// for, what a team change or a restored draft drops (and the note naming it), what it creates
// (`issue.create`) and what it keeps as a draft (`draft.save`). The component and the draft
// adapter call these; the tests drive them directly.
import {
  formatEstimate,
  isValidEstimate,
  issueStatusProblem,
  issueTitleProblem,
  type DocNodeJSON,
  type EstimateConfig,
  type StatusCategory,
  type ColorHue,
} from '@surface/domain';
import {
  EMPTY_COMPOSER_DRAFT,
  readComposerDraft,
  type ComposerDraftData,
} from '@surface/domain/model';
import type { InputOf, issueCreate } from '@surface/operations';
import type { AddTarget } from './list-model.js';

export interface ComposerTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly private: boolean;
  readonly defaultStatusId: string;
  readonly estimate: EstimateConfig;
}

export interface ComposerStatus {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly position: string;
  readonly color: ColorHue;
}

export interface ComposerLabel {
  readonly id: string;
  /** Null for a workspace label. */
  readonly teamId: string | null;
  readonly name: string;
  readonly archived: boolean;
  readonly isGroup: boolean;
  readonly parentId: string | null;
  readonly exclusive: boolean;
  readonly color: ColorHue;
}

export interface ComposerUser {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly displayName: string;
  readonly email: string;
}

/** What the composer reads from the replica. Every list holds only rows the user can see. */
export interface ComposerWorld {
  /** The signed-in user. */
  readonly me: string;
  /** The teams the user can see. */
  readonly teams: readonly ComposerTeam[];
  /** The teams the user is a member of, in sidebar order. */
  readonly memberTeamIds: readonly string[];
  /** Members per team (only private teams' are needed). */
  readonly members: Readonly<Record<string, readonly string[]>>;
  readonly statuses: readonly ComposerStatus[];
  readonly labels: readonly ComposerLabel[];
  readonly users: readonly ComposerUser[];
  /** The home team preference, if set. */
  readonly homeTeamId: string | null;
}

/** What the composer holds, apart from its team. `statusId` null shows the team's default. */
export interface ComposerFields {
  readonly title: string;
  /** TODO(PLAN-011 S6): issue.create description. Always null until the editor is turned on. */
  readonly description: DocNodeJSON | null;
  readonly statusId: string | null;
  readonly priority: number;
  readonly assigneeId: string | null;
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
}

export interface ComposerState extends ComposerFields {
  readonly teamId: string;
}

/** The state and what had to be dropped from it, in the note's words ("status Todo"). */
export interface Adjusted {
  readonly state: ComposerState;
  readonly dropped: readonly string[];
}

const EMPTY_FIELDS: ComposerFields = {
  title: '',
  description: null,
  statusId: null,
  priority: 0,
  assigneeId: null,
  labelIds: [],
  estimate: null,
  dueDate: null,
};

const teamOf = (world: ComposerWorld, id: string) => world.teams.find((t) => t.id === id);

/**
 * The team the composer opens for (§3.1 item 2): the route's team, else the home team, else the
 * first team the user is a member of, else the first team the user can see. Undefined when the
 * user can see no team (item 3: the composer doesn't open).
 */
export function prefillTeam(
  world: ComposerWorld,
  routeKey: string | undefined,
): ComposerTeam | undefined {
  const visible = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : teamOf(world, id);
  const byKey =
    routeKey === undefined
      ? undefined
      : world.teams.find((t) => t.key.toUpperCase() === routeKey.toUpperCase());
  const firstMember = world.memberTeamIds.map(visible).find((t) => t !== undefined);
  const firstVisible = [...world.teams].sort((a, b) => a.name.localeCompare(b.name))[0];
  return byKey ?? visible(world.homeTeamId) ?? firstMember ?? firstVisible;
}

/**
 * The state a fresh composer starts with. A group's `+` (§3.1 item 2) sets the group's status; on
 * My issues, where the group is a status name across teams, the team's status of that name; on
 * the Assigned tab it also assigns the user.
 */
export function freshState(world: ComposerWorld, teamId: string, add?: AddTarget): ComposerState {
  let statusId: string | null = null;
  if (add !== undefined) {
    const own = world.statuses.find((s) => s.id === add.statusId && s.teamId === teamId);
    const named = world.statuses.find(
      (s) => s.teamId === teamId && s.name.toLowerCase() === add.statusName.toLowerCase(),
    );
    const status = own ?? named;
    if (status !== undefined && issueStatusProblem(status.category) === undefined) {
      statusId = status.id;
    }
  }
  return {
    ...EMPTY_FIELDS,
    teamId,
    statusId,
    assigneeId: add?.assignToMe === true ? world.me : null,
  };
}

/** Whether the composer holds anything worth keeping: a title or a description (§3.2). */
export function hasContent(fields: Pick<ComposerFields, 'title' | 'description'>): boolean {
  return fields.title.trim() !== '' || fields.description !== null;
}

/** Whether `user` may be assigned in `team`: anyone active, and in a private team only members. */
function assignable(world: ComposerWorld, team: ComposerTeam, userId: string): boolean {
  const user = world.users.find((u) => u.id === userId);
  if (user === undefined || !user.active) return false;
  return !team.private || (world.members[team.id]?.includes(userId) ?? false);
}

/** Labels the composer may keep for `team`: its own and workspace labels, not archived, not groups. */
function usableLabel(label: ComposerLabel | undefined, team: ComposerTeam): boolean {
  return (
    label !== undefined &&
    !label.archived &&
    !label.isGroup &&
    (label.teamId === null || label.teamId === team.id)
  );
}

/**
 * Keeps what still resolves in `team` and drops the rest (§3.1 item 4, §3.2): a status not of the
 * team (or gone, or Triage/Duplicate), labels of another team, archived or gone, an estimate the
 * team's scale doesn't allow, an assignee who can't be assigned there. Title, description,
 * priority, due date and workspace labels are kept.
 */
export function fitToTeam(
  world: ComposerWorld,
  fields: ComposerFields,
  team: ComposerTeam,
): Adjusted {
  const dropped: string[] = [];
  let statusId = fields.statusId;
  if (statusId !== null) {
    const status = world.statuses.find((s) => s.id === statusId);
    if (
      status === undefined ||
      status.teamId !== team.id ||
      issueStatusProblem(status.category) !== undefined
    ) {
      dropped.push(status === undefined ? 'a deleted status' : `status ${status.name}`);
      statusId = null;
    }
  }
  const labelIds: string[] = [];
  for (const id of fields.labelIds) {
    const label = world.labels.find((l) => l.id === id);
    if (usableLabel(label, team)) labelIds.push(id);
    else dropped.push(label === undefined ? 'a deleted label' : `label ${label.name}`);
  }
  let estimate = fields.estimate;
  if (!isValidEstimate(team.estimate, estimate) && estimate !== null) {
    dropped.push(`estimate ${String(estimate)}`);
    estimate = null;
  }
  let assigneeId = fields.assigneeId;
  if (assigneeId !== null && !assignable(world, team, assigneeId)) {
    const user = world.users.find((u) => u.id === assigneeId);
    dropped.push(user === undefined ? 'an assignee who left' : `assignee ${user.name}`);
    assigneeId = null;
  }
  return {
    state: { ...fields, teamId: team.id, statusId, labelIds, estimate, assigneeId },
    dropped,
  };
}

/** A team change (§3.1 item 4): `fitToTeam`, with the estimate named as the old team showed it. */
export function changeTeam(world: ComposerWorld, state: ComposerState, teamId: string): Adjusted {
  const team = teamOf(world, teamId);
  if (team === undefined) return { state, dropped: [] };
  const adjusted = fitToTeam(world, state, team);
  const before = teamOf(world, state.teamId);
  const estimate = state.estimate;
  if (before === undefined || estimate === null || adjusted.state.estimate !== null) {
    return adjusted;
  }
  const label = `estimate ${formatEstimate(before.estimate, estimate)}`;
  return {
    state: adjusted.state,
    dropped: adjusted.dropped.map((d) => (d === `estimate ${String(estimate)}` ? label : d)),
  };
}

/**
 * A composer draft restored into `teamId` (§3.2): its data read field by field, then fitted to
 * the team. `fromHiddenTeam` (E7): the draft's own team is one the user can no longer see, so it
 * opens in `teamId` (the default team) and the note says so.
 */
export function restoreDraft(
  world: ComposerWorld,
  data: unknown,
  teamId: string,
  fromHiddenTeam = false,
): Adjusted | undefined {
  const team = teamOf(world, teamId);
  if (team === undefined) return undefined;
  const stored = readComposerDraft(data);
  const adjusted = fitToTeam(world, fieldsOf(stored), team);
  return fromHiddenTeam
    ? {
        state: adjusted.state,
        dropped: ['its team, which you can no longer see', ...adjusted.dropped],
      }
    : adjusted;
}

function fieldsOf(data: ComposerDraftData): ComposerFields {
  return {
    title: data.title,
    description: data.description,
    statusId: data.statusId,
    priority: data.priority,
    assigneeId: data.assigneeId,
    labelIds: data.labelIds,
    estimate: data.estimate,
    dueDate: data.dueDate,
  };
}

/** The note under the header: "Dropped: status Todo, label Frontend, assignee Ada." */
export function droppedNote(dropped: readonly string[]): string | undefined {
  return dropped.length === 0 ? undefined : `Dropped: ${dropped.join(', ')}.`;
}

/** What `draft.save` keeps for the composer (SPEC-012 §4.3). */
export function draftData(state: ComposerFields): ComposerDraftData {
  return {
    title: state.title,
    description: state.description,
    statusId: state.statusId,
    priority: state.priority,
    assigneeId: state.assigneeId,
    labelIds: [...state.labelIds],
    estimate: state.estimate,
    dueDate: state.dueDate,
  };
}

export const EMPTY_DRAFT_DATA = EMPTY_COMPOSER_DRAFT;

export type CreateInput = InputOf<typeof issueCreate>;

/** Why the composer can't create yet: the title rule of SPEC-011 §4.1 ("Title is required."). */
export function createProblem(state: ComposerFields): string | undefined {
  return issueTitleProblem(state.title);
}

/**
 * The `issue.create` input (§3.1 item 6): ids for every reference, so nothing is resolved by name.
 * Empty properties are left out, so the server applies its defaults (the team's default status).
 * TODO(PLAN-011 S6): issue.create description. The payload carries none until S6.
 */
export function createPayload(state: ComposerState, id: string): CreateInput {
  return {
    id,
    team: state.teamId,
    title: state.title,
    ...(state.statusId === null ? {} : { status: state.statusId }),
    ...(state.priority === 0 ? {} : { priority: state.priority }),
    ...(state.assigneeId === null ? {} : { assignee: state.assigneeId }),
    ...(state.labelIds.length === 0 ? {} : { labels: [...state.labelIds] }),
    ...(state.estimate === null ? {} : { estimate: state.estimate }),
    ...(state.dueDate === null ? {} : { dueDate: state.dueDate }),
  };
}

const str = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' ? value : null;
};

/**
 * The composer state of a rejected `issue.create` (§3.1 item 9, "Restore in composer"): the input
 * as the composer sent it, ids everywhere. Undefined for an input the composer didn't make.
 */
export function stateFromCreateInput(world: ComposerWorld, input: unknown): Adjusted | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record: Record<string, unknown> = { ...input };
  const teamRef = str(record, 'team');
  const team =
    teamRef === null
      ? undefined
      : world.teams.find((t) => t.id === teamRef || t.key.toUpperCase() === teamRef.toUpperCase());
  if (team === undefined) return undefined;
  const labels = record['labels'];
  const priority = record['priority'];
  const estimate = record['estimate'];
  return fitToTeam(
    world,
    {
      title: str(record, 'title') ?? '',
      description: null,
      statusId: str(record, 'status'),
      priority: typeof priority === 'number' ? priority : 0,
      assigneeId: str(record, 'assignee'),
      labelIds: Array.isArray(labels)
        ? labels.filter((l): l is string => typeof l === 'string')
        : [],
      estimate: typeof estimate === 'number' ? estimate : null,
      dueDate: str(record, 'dueDate'),
    },
    team,
  );
}

/** Whether two states hold the same issue (the replace prompt is skipped when they do, E20). */
export function sameContent(a: ComposerState, b: ComposerState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
