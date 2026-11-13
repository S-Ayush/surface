/**
 * The issue models (SPEC-011 §4.1, §5.1). `Issue` is eager and has no description: that is
 * `IssueContent`, a content model PLAN-011 S5a adds with `IssueHistory` (their tables exist since
 * S3). Labels are an id array on the row, not a join model (Q17).
 *
 * Issue declares `groups` like every team-scoped model, so the client can tell which of its
 * groups keep a row (SPEC-011 §5.7).
 */
import { defineModel, ref } from './define-model.js';
import { array, day, int, str, timestamp, uuid } from './fields.js';

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
