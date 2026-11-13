/**
 * Comments and reactions (SPEC-013 §4.1, §4.2, §5.1): content models with parent `Issue`, loaded
 * per issue with its description and history (`GET /sync/content`). Like `IssueContent`, they
 * declare no `groups` field: a content row leaves the replica with its parent, which carries the
 * groups (PLAN-011 S5a). The server stores `team:<teamId>` only, never the issue's `user:` groups
 * (SPEC-013 D12), with `teamId` taken from the issue row.
 *
 * The comment's plain text for search is server-only (`comment_search_text`), never a field here
 * (SPEC-013 D2).
 */
import { COMMENT_ACTOR_KINDS } from '../comment.js';
import { defineModel, ref } from './define-model.js';
import { enumOf, int, json, str, timestamp, uuid } from './fields.js';

export const Comment = defineModel('Comment', {
  load: 'content',
  parent: { model: 'Issue', field: 'issueId' },
  fields: {
    issueId: uuid(),
    /** The issue's team, set by the server from the issue row (SPEC-011 §5.1). */
    teamId: uuid(),
    /** A live top-level comment of the same issue (INV-19); null for a top-level comment. */
    parentCommentId: uuid().nullable(),
    /** The author; for `api` and `mcp`, the key's owner. */
    userId: uuid(),
    actorKind: enumOf(COMMENT_ACTOR_KINDS),
    /** Editor JSON (SPEC-013 §4.4), at most 50 KB; `EMPTY_DOC` once soft-deleted. */
    body: json(),
    /** 1 at creation, +1 on every update and on a soft delete; never on resolve (§4.3). */
    version: int(),
    editedAt: timestamp().nullable(),
    /** Set when a comment with replies is deleted: a placeholder (§4.3). */
    deletedAt: timestamp().nullable(),
    /** Top-level comments only: the thread's resolved state (§3.3a). */
    resolvedAt: timestamp().nullable(),
    resolvedById: uuid().nullable(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  refs: {
    issue: ref('Issue', 'issueId'),
    team: ref('Team', 'teamId'),
    parent: ref('Comment', 'parentCommentId'),
    author: ref('User', 'userId'),
    resolvedBy: ref('User', 'resolvedById'),
  },
  indexes: ['issueId', 'parentCommentId'],
});

/**
 * A reaction on a comment, or on the issue itself when `commentId` is null (SPEC-013 §4.2, D8).
 * Its id is `reactionId(subjectId, userId, emoji)`, the same on client and server. Written only by
 * `reaction.set` (PLAN-013 S4); the table and model arrive with comments.
 */
export const Reaction = defineModel('Reaction', {
  load: 'content',
  parent: { model: 'Issue', field: 'issueId' },
  fields: {
    issueId: uuid(),
    teamId: uuid(),
    commentId: uuid().nullable(),
    userId: uuid(),
    /** Exactly one RGI emoji (SPEC-013 §4.4 "Emoji"). */
    emoji: str(),
    createdAt: timestamp(),
  },
  refs: {
    issue: ref('Issue', 'issueId'),
    team: ref('Team', 'teamId'),
    comment: ref('Comment', 'commentId'),
    user: ref('User', 'userId'),
  },
  indexes: ['issueId', 'commentId'],
});
