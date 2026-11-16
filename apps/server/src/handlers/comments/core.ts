/**
 * The rules of `comment.create`, `update`, `delete`, `resolve` and `reopen` (SPEC-013 §4.3, §5.2,
 * §6.1, §6.3), written against `CommentAccess` (reads and locks) and the repo (writes), so the unit
 * tests run them in memory while the handlers run them on Postgres (`access.ts`). The pure checks
 * live in the domain package (`comment.ts`), which the client's `optimistic` calls too.
 *
 * Order of work (§4.3): `lockIssueForWrite` in the operation's mode, `edit` (archived and deleted issues are
 * `CONFLICT`, D10), then the thread's root comment `FOR UPDATE`, then every comment row the rule
 * depends on is re-read under those locks, then the writes go through the repo, which logs each
 * row. Lock order is always issue row, then thread root, so every write to one thread is serial.
 * Foreign keys never cascade: replies and reactions are deleted through the repo, each with its
 * `D` delta. Comments write no history (D24); events carry ids, never the body.
 */
import {
  COMMENT_MESSAGES,
  commentDeletePlan,
  DOC_MAX_BYTES,
  docJsonBytes,
  EMPTY_DOC,
  isSet,
  issueLockModeOf,
  replyParentProblem,
  type CommentActorKind,
  type DocNodeJSON,
  type IssueLockMode,
} from '@surface/domain';
import { docFileIds, docToText, markdownToDoc, validateDoc } from '@surface/editor/schema';
import type { DomainEvent } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { LockedIssue } from '../../issues/lifecycle.js';
import type { ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type CommentRow = ModelRow<'Comment'>;

/** Reads and locks, in the order of §4.3. Every method runs in the operation's transaction. */
export interface CommentAccess {
  /**
   * `lockIssueForWrite` in `mode`, the mode the lifecycle rule table gives the operation
   * (`issueLockModeOf`, SPEC-015 §4.3): `edit` for every comment operation, so archived and
   * deleted issues are `CONFLICT` (D10).
   */
  lockIssue(issueId: string, mode: IssueLockMode): Promise<LockedIssue>;
  /** A thread's root `FOR UPDATE`; undefined when it is gone. */
  lockComment(commentId: string): Promise<CommentRow | undefined>;
  /** A comment without a lock (its thread's root is locked); undefined when it is gone. */
  readComment(commentId: string): Promise<CommentRow | undefined>;
  /** The ids of a top-level comment's replies, in ascending id. */
  replyIds(rootId: string): Promise<string[]>;
  /** Writes the server-only search text (D2), or deletes it with `null`. */
  setSearchText(commentId: string, text: string | null): Promise<void>;
  /** `claimInlineFiles` (SPEC-014 §4.3): the document to store, or `INVALID_INPUT`. */
  claimFiles(doc: DocNodeJSON, issue: LockedIssue): Promise<DocNodeJSON>;
  /**
   * The reactions on one subject, read under its lock (PLAN-013 S4): a comment's, or with
   * `commentId` null the issue's own (SPEC-013 §4.2, D8).
   */
  reactionsOn(issueId: string, commentId: string | null): Promise<ReactionRow[]>;
}

export type ReactionRow = ModelRow<'Reaction'>;

/** Who writes: the user, or for `api` and `mcp` the key's owner (§4.1, D16). */
export interface CommentAuthor {
  readonly userId: string;
  readonly actorKind: CommentActorKind;
  readonly admin: boolean;
}

/** What the rules need from the operation besides reads and writes. */
export interface CommentWriteContext {
  readonly access: CommentAccess;
  readonly repo: Repo;
  readonly emit: (event: DomainEvent) => void;
  readonly now: Date;
  readonly author: CommentAuthor;
}

/** A resolved `CommentRef`: the comment, its issue and its thread's root. */
export interface CommentTarget {
  readonly commentId: string;
  readonly issueId: string;
  readonly rootId: string;
}

function invalid(field: string, message: string, path: readonly (string | number)[] = []) {
  return new SurfaceError('INVALID_INPUT', message, {
    issues: [{ path: [field, ...path], message }],
  });
}

/**
 * The input body as a valid document (§4.4, §6.3): Markdown is converted first, then the document
 * is validated, measured (50 KB, D14) and checked for content. Text, an image or a file counts.
 */
export function commentDoc(body: string | Readonly<Record<string, unknown>>): DocNodeJSON {
  const result = validateDoc(typeof body === 'string' ? markdownToDoc(body) : body);
  if (!result.ok) {
    const [first] = result.problems;
    throw new SurfaceError('INVALID_INPUT', first?.message ?? COMMENT_MESSAGES.empty, {
      issues: result.problems.map((p) => ({ path: ['body', ...p.path], message: p.message })),
    });
  }
  const doc = result.doc;
  if (docJsonBytes(doc) > DOC_MAX_BYTES.comment) throw invalid('body', COMMENT_MESSAGES.tooLong);
  if (docToText(doc).trim() === '' && docFileIds(doc).length === 0) {
    throw invalid('body', COMMENT_MESSAGES.empty);
  }
  return doc;
}

/** JSON with sorted keys: `jsonb` stores keys in its own order, so compare by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/**
 * The comment a `CommentRef` named, re-read after the thread lock (§4.3 step 3), or `NOT_FOUND`
 * worded as for a comment that never existed (it was deleted in between).
 */
export async function lockTarget(
  ctx: CommentWriteContext,
  target: CommentTarget,
  operation: string,
): Promise<{ issue: LockedIssue; root: CommentRow; comment: CommentRow }> {
  const issue = await ctx.access.lockIssue(target.issueId, issueLockModeOf(operation));
  const root = await ctx.access.lockComment(target.rootId);
  const comment =
    target.commentId === target.rootId ? root : await ctx.access.readComment(target.commentId);
  if (root === undefined || comment === undefined || comment.issueId !== issue.id) {
    throw refNotFound('CommentRef', target.commentId, ['comment']);
  }
  return { issue, root, comment };
}

export interface CreateCommentInput {
  readonly id: string;
  readonly issueId: string;
  /** The resolved `parent`, for a reply. */
  readonly parentId?: string | undefined;
  readonly body: string | Readonly<Record<string, unknown>>;
}

/** `comment.create` (§6.1): a comment on a live issue, or a reply to a live top-level comment. */
export async function createComment(
  ctx: CommentWriteContext,
  input: CreateCommentInput,
): Promise<CommentRow> {
  const doc = commentDoc(input.body);
  const issue = await ctx.access.lockIssue(input.issueId, issueLockModeOf('comment.create'));
  if (input.parentId !== undefined) {
    const parent = await ctx.access.lockComment(input.parentId);
    if (parent === undefined) throw refNotFound('CommentRef', input.parentId, ['parent']);
    // INV-19 on the row as the thread lock holds it (E2: a delete that won the lock refuses this).
    const problem = replyParentProblem(parent, issue.id);
    if (problem !== undefined) throw invalid('parent', problem);
  }
  const body = await ctx.access.claimFiles(doc, issue);
  const row = await ctx.repo.insert('Comment', {
    id: input.id,
    issueId: issue.id,
    // The repo stores the issue row's team whatever is passed (SPEC-011 §5.1, D4).
    teamId: issue.teamId,
    parentCommentId: input.parentId ?? null,
    userId: ctx.author.userId,
    actorKind: ctx.author.actorKind,
    body,
    version: 1,
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedById: null,
  });
  await ctx.access.setSearchText(row.id, docToText(body));
  ctx.emit({
    type: 'comment.created',
    subject: { type: 'comment', id: row.id },
    data: { issueId: issue.id, parentId: row.parentCommentId },
  });
  return row;
}

export interface UpdateCommentInput extends CommentTarget {
  readonly baseVersion: number;
  readonly body: string | Readonly<Record<string, unknown>>;
}

/**
 * `comment.update` (§4.3): the author only; a stale `baseVersion` is `CONFLICT`. Every update
 * raises `version` and sets `editedAt`, even when the stored body comes out the same (E22), but
 * then writes no `comment.updated` event.
 */
export async function updateComment(
  ctx: CommentWriteContext,
  input: UpdateCommentInput,
): Promise<CommentRow> {
  const doc = commentDoc(input.body);
  const { issue, comment } = await lockTarget(ctx, input, 'comment.update');
  // A placeholder can't be edited (§4.3): as if it were gone.
  if (isSet(comment.deletedAt)) throw refNotFound('CommentRef', input.commentId, ['comment']);
  if (comment.userId !== ctx.author.userId) {
    throw new SurfaceError('FORBIDDEN', COMMENT_MESSAGES.notAuthor);
  }
  if (comment.version !== input.baseVersion) {
    throw new SurfaceError('CONFLICT', COMMENT_MESSAGES.staleVersion);
  }
  const body = await ctx.access.claimFiles(doc, issue);
  const changed = canonical(body) !== canonical(comment.body);
  const row = await ctx.repo.update('Comment', comment.id, {
    body,
    version: comment.version + 1,
    editedAt: ctx.now,
  });
  await ctx.access.setSearchText(row.id, docToText(body));
  if (changed) {
    ctx.emit({
      type: 'comment.updated',
      subject: { type: 'comment', id: row.id },
      data: { issueId: row.issueId, version: row.version },
    });
  }
  return row;
}

/** Deletes a comment's reactions through the repo, one `D` each (§4.3: no cascade). */
async function deleteReactions(ctx: CommentWriteContext, commentId: string): Promise<void> {
  await ctx.repo.deleteWhere('Reaction', 'commentId', [commentId]);
}

/**
 * `comment.delete` (§4.3): the author or an Admin. Hard without replies, soft (a placeholder)
 * with replies; the last reply of a placeholder takes the placeholder with it (E13).
 */
export async function deleteComment(
  ctx: CommentWriteContext,
  input: CommentTarget,
): Promise<{ readonly comment: string; readonly mode: 'hard' | 'soft' }> {
  const { root, comment } = await lockTarget(ctx, input, 'comment.delete');
  if (isSet(comment.deletedAt)) throw refNotFound('CommentRef', input.commentId, ['comment']);
  if (comment.userId !== ctx.author.userId && !ctx.author.admin) {
    throw new SurfaceError('FORBIDDEN', COMMENT_MESSAGES.notAuthorDelete);
  }
  const isReply = comment.parentCommentId !== null;
  // Re-read under the thread lock (E2, E13): replies of a root; for a reply, the root's replies.
  const replyIds = isReply ? [] : await ctx.access.replyIds(comment.id);
  const parent = isReply
    ? { id: root.id, deletedAt: root.deletedAt, replyIds: await ctx.access.replyIds(root.id) }
    : undefined;
  const plan = commentDeletePlan(comment, replyIds, parent);

  await deleteReactions(ctx, comment.id);
  if (plan.mode === 'soft') {
    await ctx.repo.update('Comment', comment.id, {
      body: EMPTY_DOC,
      deletedAt: ctx.now,
      version: comment.version + 1,
    });
  } else {
    await ctx.repo.purge('Comment', comment.id);
  }
  await ctx.access.setSearchText(comment.id, null);
  if (plan.alsoParent !== undefined) {
    // A placeholder's reactions went with its soft delete, and it takes none since (NOT_FOUND).
    await deleteReactions(ctx, plan.alsoParent);
    await ctx.repo.purge('Comment', plan.alsoParent);
  }
  ctx.emit({
    type: 'comment.deleted',
    subject: { type: 'comment', id: comment.id },
    data: { issueId: comment.issueId, mode: plan.mode },
  });
  return { comment: comment.id, mode: plan.mode };
}

/**
 * `comment.resolve` (`resolved` true) and `comment.reopen` (false), §4.3: on the thread's root,
 * placeholder or not. The state that already holds changes nothing: no write, no event. Leaves
 * `version` and `editedAt` alone.
 */
export async function setThreadResolved(
  ctx: CommentWriteContext,
  input: CommentTarget,
  resolved: boolean,
): Promise<CommentRow> {
  const { root } = await lockTarget(ctx, input, resolved ? 'comment.resolve' : 'comment.reopen');
  if (isSet(root.resolvedAt) === resolved) return root;
  const row = await ctx.repo.update('Comment', root.id, {
    resolvedAt: resolved ? ctx.now : null,
    resolvedById: resolved ? ctx.author.userId : null,
  });
  ctx.emit({
    type: resolved ? 'comment.resolved' : 'comment.reopened',
    subject: { type: 'comment', id: row.id },
    data: { issueId: row.issueId },
  });
  return row;
}
