/**
 * The issue models (SPEC-011 §4.1, §5.1). `Issue` is eager and has no description: that is
 * `IssueContent`, a content model loaded per issue with `IssueHistory` (PLAN-011 S5a; their
 * tables exist since S3). Labels are an id array on the row, not a join model (Q17).
 *
 * Issue declares `groups` like every team-scoped model, so the client can tell which of its
 * groups keep a row (SPEC-011 §5.7).
 */
import { HISTORY_ACTOR_KINDS, ISSUE_HISTORY_KINDS } from '../issue.js';
import { defineModel, ref } from './define-model.js';
import { array, day, enumOf, int, json, str, timestamp, uuid } from './fields.js';

export const Issue = defineModel('Issue', {
  load: 'eager',
  fields: {
    teamId: uuid(),
    /** Assigned by the server in the creating transaction; null only in the client's overlay. */
    number: int().nullable(),
    title: str(),
    statusId: uuid(),
    /** 0 none, 1 urgent … 4 low (`PRIORITIES`). */
    priority: int(),
    assigneeId: uuid().nullable(),
    /** In insertion order; displayed ordered by label name (§4.2). */
    labelIds: array(uuid()),
    estimate: int().nullable(),
    dueDate: day().nullable(),
    /** Global manual order: a fractional key with jitter (`order-key.ts`), compared in byte order. */
    sortOrder: str(),
    /** Never null (§4.1): the groups builder relies on it. */
    creatorId: uuid(),
    startedAt: timestamp().nullable(),
    completedAt: timestamp().nullable(),
    canceledAt: timestamp().nullable(),
    /** Set only by the auto-archive job, cleared only by restore (SPEC-015). */
    archivedAt: timestamp().nullable(),
    deletedAt: timestamp().nullable(),
    deletedById: uuid().nullable(),
    groups: array(str()),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  refs: {
    team: ref('Team', 'teamId'),
    status: ref('WorkflowStatus', 'statusId'),
    assignee: ref('User', 'assigneeId'),
    creator: ref('User', 'creatorId'),
    deletedBy: ref('User', 'deletedById'),
  },
  indexes: ['teamId', 'statusId', 'assigneeId', 'number'],
});

/**
 * An issue's description (SPEC-011 §4.3): one row per issue, `id` = the issue's id. Content: a
 * client loads it per issue (`GET /sync/content`). `teamId` is the issue's, set by the repo from
 * the issue row (§5.1, D4); its only group is `team:<teamId>`.
 */
export const IssueContent = defineModel('IssueContent', {
  load: 'content',
  parent: { model: 'Issue', field: 'issueId' },
  fields: {
    issueId: uuid(),
    teamId: uuid(),
    /** Editor JSON (SPEC-013); `EMPTY_DOC` when empty, never null. At most 200 KB (Q9). */
    description: json(),
    /** 1 at creation, +1 per save: `issue.updateDescription`'s `baseVersion` (S6). */
    version: int(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  refs: {
    issue: ref('Issue', 'issueId'),
    team: ref('Team', 'teamId'),
  },
  indexes: ['issueId'],
});

/**
 * An issue's activity (SPEC-011 §4.4). Content, like `IssueContent`. `changes` maps a field to
 * `{ from, to }` with names stored next to ids; `updatedAt` moves when an entry is folded.
 */
export const IssueHistory = defineModel('IssueHistory', {
  load: 'content',
  parent: { model: 'Issue', field: 'issueId' },
  fields: {
    issueId: uuid(),
    teamId: uuid(),
    actorKind: enumOf(HISTORY_ACTOR_KINDS),
    /** Null for `system`; the key's owner for `api` and `mcp`. */
    actorId: uuid().nullable(),
    apiKeyId: uuid().nullable(),
    kind: enumOf(ISSUE_HISTORY_KINDS),
    changes: json(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  refs: {
    issue: ref('Issue', 'issueId'),
    team: ref('Team', 'teamId'),
    actor: ref('User', 'actorId'),
  },
  indexes: ['issueId'],
});
