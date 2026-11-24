/**
 * The workspace, identity and team models (PLAN-001 S1, SPEC-001 §5): the first production
 * models. Shared by the client store and the server's sync registry, so they define the schema
 * hash. A synced table has no column a model doesn't declare (apart from sync bookkeeping):
 * secrets and counters live in server-only tables (`user_credentials`, `team_issue_counters`).
 *
 * Models scoped to a team declare `groups`: the client needs a row's groups to purge it when it
 * leaves a private team (SPEC-002 Q6, Q8). Workspace-wide and user-scoped models don't.
 */
import { STATUS_CATEGORIES } from '../status-category.js';
import { COLOR_HUES, ESTIMATE_SCALES, SIGNUP_POLICIES, USER_ROLES } from '../workspace.js';
import { backRef, defineModel, ref } from './define-model.js';
import { array, bool, enumOf, int, json, str, timestamp, uuid } from './fields.js';
import { Issue, IssueContent, IssueHistory } from './issue-models.js';
import { Draft } from './draft.js';
import { Comment, Reaction } from './comment-models.js';
import { Attachment } from './attachment-models.js';

const audit = { createdAt: timestamp(), updatedAt: timestamp() };

/** The singleton workspace (INV-01). */
export const Workspace = defineModel('Workspace', {
  load: 'eager',
  fields: {
    name: str(),
    logoFileId: uuid().nullable(),
    signupPolicy: enumOf(SIGNUP_POLICIES),
    allowedDomain: str().nullable(),
    mcpEnabled: bool(),
    /** `{ weekday, hour }` for project update reminders, or null. */
    updateReminder: json().nullable(),
    /** Settings new teams start with. */
    defaults: json(),
    ...audit,
  },
});

/** A user's public fields (SPEC-001 §5). Email is synced: everyone is a colleague. */
export const User = defineModel('User', {
  load: 'eager',
  fields: {
    email: str(),
    name: str(),
    displayName: str(),
    avatarFileId: uuid().nullable(),
    timezone: str(),
    role: enumOf(USER_ROLES),
    active: bool(),
    ...audit,
  },
  refs: { memberships: backRef('TeamMembership', 'userId') },
  indexes: ['email', 'displayName'],
});

/**
 * A user's preferences, synced only to that user (`user:<id>`). The row's id is the user's id.
 * `values` is checked by `user.updatePreferences` (PLAN-005 S7), which owns its shape.
 */
export const UserPreferences = defineModel('UserPreferences', {
  load: 'eager',
  fields: {
    values: json(),
    ...audit,
  },
});

export const Team = defineModel('Team', {
  load: 'eager',
  fields: {
    key: str(),
    name: str(),
    icon: str().nullable(),
    color: enumOf(COLOR_HUES),
    timezone: str(),
    private: bool(),
    triageEnabled: bool(),
    defaultStatusId: uuid(),
    estimateScale: enumOf(ESTIMATE_SCALES),
    /** Estimate options (SPEC-010 §4.3): two larger values, 0 as a real value, and how M3
     *  cycle statistics count unestimated issues. */
    estimateExtended: bool(),
    estimateAllowZero: bool(),
    estimateCountUnestimatedAsOne: bool(),
    cyclesEnabled: bool(),
    cycleDurationWeeks: int(),
    cycleCooldownWeeks: int(),
    cycleStartWeekday: int(),
    cycleUpcomingCount: int(),
    cycleAutoAddStarted: bool(),
    cycleAutoAddCompleted: bool(),
    /** Auto-archive period in months: 1, 3, 6, 9 or 12 (SPEC-015 §3.2), never off. */
    autoArchiveMonths: int(),
    /** Auto-close period in months (same choices), or null when auto-close is off. */
    autoCloseMonths: int().nullable(),
    /** The Canceled status auto-close moves stale issues to; set whenever auto-close is on. */
    autoCloseStatusId: uuid().nullable(),
    parentAutoComplete: bool(),
    groups: array(str()),
    ...audit,
  },
  refs: {
    defaultStatus: ref('WorkflowStatus', 'defaultStatusId'),
    autoCloseStatus: ref('WorkflowStatus', 'autoCloseStatusId'),
    memberships: backRef('TeamMembership', 'teamId'),
    statuses: backRef('WorkflowStatus', 'teamId'),
    labels: backRef('Label', 'teamId'),
  },
  indexes: ['key'],
});

export const TeamMembership = defineModel('TeamMembership', {
  load: 'eager',
  fields: {
    teamId: uuid(),
    userId: uuid(),
    triageResponsible: bool(),
    groups: array(str()),
    ...audit,
  },
  refs: { team: ref('Team', 'teamId'), user: ref('User', 'userId') },
});

export const WorkflowStatus = defineModel('WorkflowStatus', {
  load: 'eager',
  fields: {
    teamId: uuid(),
    name: str(),
    category: enumOf(STATUS_CATEGORIES),
    color: enumOf(COLOR_HUES),
    description: str().nullable(),
    /** Order within the category: a fractional-index key (domain-model §1, manual order). */
    position: str(),
    groups: array(str()),
    ...audit,
  },
  refs: { team: ref('Team', 'teamId') },
});

/** A team label, or a workspace label when `teamId` is null. */
export const Label = defineModel('Label', {
  load: 'eager',
  fields: {
    teamId: uuid().nullable(),
    name: str(),
    color: enumOf(COLOR_HUES),
    description: str().nullable(),
    parentId: uuid().nullable(),
    isGroup: bool(),
    /** Groups only: single-select (SPEC-010 §4.2, INV-07). Default true. */
    exclusive: bool(),
    groups: array(str()),
    ...audit,
    /**
     * Set while archived (SPEC-010). Synced since protocol v0.7 (SPEC-011 §5.5): the client derives
     * `$archived` from it, and an archived label stays in the replica.
     */
    archivedAt: timestamp().nullable(),
  },
  refs: {
    team: ref('Team', 'teamId'),
    parent: ref('Label', 'parentId'),
    children: backRef('Label', 'parentId'),
  },
});

/** Every production model, in a stable order: the list the client store and server register. */
export const PRODUCTION_MODELS = [
  Workspace,
  User,
  UserPreferences,
  Team,
  TeamMembership,
  WorkflowStatus,
  Label,
  Issue,
  IssueContent,
  IssueHistory,
  Draft,
  Comment,
  Reaction,
  Attachment,
] as const;
