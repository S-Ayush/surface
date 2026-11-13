/**
 * Comment rules shared by the server handlers and the client's optimistic code (SPEC-013 §4.1,
 * §4.3, §4.5, §6.3). The checks are pure: the server runs them on rows it read under the thread
 * lock, the client on rows its store holds.
 */
import { docJsonBytes } from './doc.js';
import { defineFilterFields } from './filter/fields.js';
import { utf8Length } from './sha1.js';

/** `comment.list` filter fields (SPEC-013 §6.1, SPEC-003 §7.4); the list is one issue's. */
export const COMMENT_FILTER_FIELDS = defineFilterFields({
  author: { type: 'ref' },
  createdAt: { type: 'instant' },
  editedAt: { type: 'instant' },
  resolvedAt: { type: 'instant' },
});

/** Who wrote a comment (SPEC-013 §4.1, D16). `system` arrives with the first system comment. */
export const COMMENT_ACTOR_KINDS = ['user', 'api', 'mcp'] as const;
export type CommentActorKind = (typeof COMMENT_ACTOR_KINDS)[number];

export function isCommentActorKind(value: unknown): value is CommentActorKind {
  return typeof value === 'string' && (COMMENT_ACTOR_KINDS as readonly string[]).includes(value);
}

/** The SPEC-013 §6.3 sentences, so the server and its tests use the same words. */
export const COMMENT_MESSAGES = {
  empty: "Comment can't be empty.",
  tooLong: 'Comment is too long. Split it into two, or attach a file.',
  notAuthor: 'Only the author can edit a comment.',
  notAuthorDelete: 'Only the author or an Admin can delete a comment.',
  replyToReply: "Replies go one level deep. Reply to the thread's first comment.",
  replyToDeleted: 'That comment was deleted. Comment on the issue instead.',
  replyOtherIssue: 'Reply to a comment of the same issue, or leave out parent.',
  staleVersion:
    'This comment changed since you started editing. Copy your text, then edit it again.',
} as const;

/**
 * The size `DOC_MAX_BYTES.comment` limits (D14): UTF-8 bytes of Markdown, or of a document's JSON.
 * The operation input checks it before the server converts or validates anything (§6.1).
 */
export function commentBodyBytes(body: unknown): number {
  return typeof body === 'string' ? utf8Length(body) : docJsonBytes(body);
}

/** What the comment invariants read of a comment row. */
export interface CommentFacts {
  readonly id: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly parentCommentId: string | null;
  readonly deletedAt: unknown;
  readonly resolvedAt: unknown;
  readonly resolvedById: string | null;
}

/** What the comment invariants read of a reaction row. */
export interface ReactionFacts {
  readonly issueId: string;
  readonly teamId: string;
  readonly commentId: string | null;
}

const isSet = (value: unknown): boolean => value !== null && value !== undefined;

/** The id of a comment's thread root: itself for a top-level comment, else its parent. */
export function threadRootId(comment: Pick<CommentFacts, 'id' | 'parentCommentId'>): string {
  return comment.parentCommentId ?? comment.id;
}

/**
 * Why a reply under `parent` is refused (INV-19, SPEC-013 §4.3, §6.3), or undefined. `parent` is
 * the row as read under the thread lock; `issueId` is the issue the reply goes on.
 */
export function replyParentProblem(
  parent: Pick<CommentFacts, 'issueId' | 'parentCommentId' | 'deletedAt'>,
  issueId: string,
): string | undefined {
  if (parent.issueId !== issueId) return COMMENT_MESSAGES.replyOtherIssue;
  if (parent.parentCommentId !== null) return COMMENT_MESSAGES.replyToReply;
  if (isSet(parent.deletedAt)) return COMMENT_MESSAGES.replyToDeleted;
  return undefined;
}

/**
 * The SPEC-013 §4.5 invariants of one comment, given its parent (when it is a reply) and its
 * issue's team. Returns every problem found, as sentences; empty when it holds.
 */
export function commentInvariantProblems(
  comment: CommentFacts,
  context: { readonly parent?: CommentFacts | undefined; readonly issueTeamId: string },
): string[] {
  const problems: string[] = [];
  if (comment.teamId !== context.issueTeamId) {
    problems.push("A comment's teamId must equal its issue's teamId.");
  }
  if (isSet(comment.resolvedAt) !== (comment.resolvedById !== null)) {
    problems.push('resolvedAt and resolvedById are set together.');
  }
  if (comment.parentCommentId !== null) {
    if (isSet(comment.resolvedAt)) problems.push('Only a top-level comment is resolved.');
    const parent = context.parent;
    if (parent === undefined || parent.id !== comment.parentCommentId) {
      problems.push("A reply's parent must exist.");
    } else {
      // INV-19: one level of replies.
      if (parent.parentCommentId !== null) problems.push('Replies are one level deep (INV-19).');
      if (parent.issueId !== comment.issueId) {
        problems.push("A reply's issueId must equal its parent's issueId.");
      }
    }
  }
  return problems;
}

/**
 * The SPEC-013 §4.5 invariants of one reaction, given its comment (when it has one) and its issue's
 * team. Empty when they hold.
 */
export function reactionInvariantProblems(
  reaction: ReactionFacts,
  context: { readonly comment?: CommentFacts | undefined; readonly issueTeamId: string },
): string[] {
  const problems: string[] = [];
  if (reaction.teamId !== context.issueTeamId) {
    problems.push("A reaction's teamId must equal its issue's teamId.");
  }
  if (reaction.commentId !== null) {
    const comment = context.comment;
    if (comment === undefined || comment.id !== reaction.commentId) {
      problems.push("A reaction's comment must exist.");
    } else if (comment.issueId !== reaction.issueId) {
      problems.push("A reaction's issueId must equal its comment's issueId.");
    }
  }
  return problems;
}

/**
 * How `comment.delete` deletes (SPEC-013 §4.3): `hard` without replies, `soft` (placeholder) with
 * replies left. `alsoParent` is the soft-deleted parent a last reply takes with it.
 */
export interface CommentDeletePlan {
  readonly mode: 'hard' | 'soft';
  readonly alsoParent: string | undefined;
}

/**
 * The delete plan for `comment`, given its replies and, for a reply, its parent and the parent's
 * other replies, all read under the thread lock.
 */
export function commentDeletePlan(
  comment: Pick<CommentFacts, 'id' | 'parentCommentId'>,
  replyIds: readonly string[],
  parent?: Pick<CommentFacts, 'id' | 'deletedAt'> & { readonly replyIds: readonly string[] },
): CommentDeletePlan {
  if (replyIds.length > 0) return { mode: 'soft', alsoParent: undefined };
  const lastReplyOfPlaceholder =
    parent !== undefined &&
    isSet(parent.deletedAt) &&
    parent.replyIds.every((id) => id === comment.id);
  return { mode: 'hard', alsoParent: lastReplyOfPlaceholder ? parent.id : undefined };
}
