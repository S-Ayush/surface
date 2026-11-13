/**
 * Comment operations (SPEC-013 §6.1; PLAN-013 S3): create, update, delete, resolve, reopen, list.
 * Anyone who can see an issue may comment on it, reply, and resolve or reopen its threads; only
 * the author edits a comment; the author or an Admin deletes one (§5.2). Visibility is the
 * executor's check on every reference: a comment of an issue the caller can't see is `NOT_FOUND`.
 *
 * Inputs check shape and size only: `body` is editor JSON or a Markdown string of at most 50 KB.
 * This package can't import the editor, so the server converts Markdown (`markdownToDoc`) and
 * validates the document (`validateDoc`). Optimistic code never parses a document: a Markdown body
 * predicts nothing, and a soft delete writes `EMPTY_DOC` from domain (§6.2).
 *
 * `contentParent` (SPEC-011 §5.3 step 6) names the issue the comment lives under. For
 * `comment.create` that is the `IssueRef` the input gives; for the operations that take a
 * `CommentRef` it is `{ model: 'Comment', id }`, meaning "the issue of this comment": the client's
 * dispatch (PLAN-011 S5b) reads the comment's `issueId` from its store.
 */
import {
  COMMENT_ACTOR_KINDS,
  COMMENT_MESSAGES,
  commentBodyBytes,
  CommentRef,
  DOC_MAX_BYTES,
  EMPTY_DOC,
  IssueRef,
  isSet,
  lifecycleOf,
  replyParentProblem,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { Timestamp } from './shared.js';

// ---------------------------------------------------------------------------------------------
// Shapes

const NewId = z
  .uuid({
    version: 'v7',
    error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
  })
  .optional();

/**
 * Editor JSON (an object) or Markdown (a string), at most 50 KB (SPEC-013 D14, §6.3). The shape
 * of the document is the server's to check (`validateDoc`), with a path for each problem.
 */
export const CommentBody = z
  .union([
    z.string().meta({ description: 'Markdown' }),
    z.record(z.string(), z.unknown()).meta({
      description: 'Editor JSON: {"type": "doc", "content": [...]}',
    }),
  ])
  .superRefine((body, ctx) => {
    if (commentBodyBytes(body) > DOC_MAX_BYTES.comment) {
      ctx.addIssue({ code: 'custom', message: COMMENT_MESSAGES.tooLong });
    }
  })
  .meta({ description: 'The text: Markdown, or editor JSON. At most 50 KB.' });

const Named = z.object({ id: z.uuid(), name: z.string() });

/** One comment (SPEC-013 §6.1). `body` is null for a deleted comment (a placeholder). */
export const CommentOutputSchema = z.object({
  id: z.uuid(),
  issue: z.object({ id: z.uuid(), identifier: z.string() }),
  /** The thread's top-level comment, for a reply; null for a top-level comment. */
  parentId: z.uuid().nullable(),
  author: Named,
  actorKind: z.enum(COMMENT_ACTOR_KINDS),
  body: z.object({ markdown: z.string(), json: z.record(z.string(), z.unknown()) }).nullable(),
  version: z.int().min(1),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
  deleted: z.boolean(),
  /** The thread's resolved state, on top-level comments; null on replies and open threads. */
  resolved: z.object({ at: Timestamp, by: Named }).nullable(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.int().min(1), mine: z.boolean() })),
});

// Fixed ids of the seed fixture's comments (`apps/server/test/seed.ts`), which the examples name.
const SEED_THREAD = '01930000-0000-7000-8000-000000000701';
const SEED_RESOLVED_THREAD = '01930000-0000-7000-8000-000000000703';

// ---------------------------------------------------------------------------------------------
// Optimistic helpers

function text(row: StoreRow | undefined, field: string): string | undefined {
  const value = row?.[field];
  return typeof value === 'string' ? value : undefined;
}

/** The issue a comment is on, when the store holds it and it is live (D10: else CONFLICT). */
function liveIssue(store: OptimisticStore, ref: string | undefined): StoreRow | undefined {
  if (ref === undefined) return undefined;
  const issue = store.get('Issue', ref);
  if (issue === undefined) return undefined;
  const state = lifecycleOf({ archivedAt: issue['archivedAt'], deletedAt: issue['deletedAt'] });
  return state === 'live' ? issue : undefined;
}

/** A live comment the store holds and its live issue, or undefined (the server answers). */
function liveComment(
  store: OptimisticStore,
  ref: string,
): { readonly comment: StoreRow; readonly id: string } | undefined {
  const comment = store.get('Comment', ref);
  const id = text(comment, 'id');
  if (comment === undefined || id === undefined) return undefined;
  if (liveIssue(store, text(comment, 'issueId')) === undefined) return undefined;
  return { comment, id };
}

/** The thread's root: the comment itself, or its parent for a reply. */
function threadRoot(store: OptimisticStore, comment: StoreRow): StoreRow | undefined {
  const parentId = text(comment, 'parentCommentId');
  return parentId === undefined ? comment : store.get('Comment', parentId);
}

function removeReactions(store: OptimisticStore, commentId: string): void {
  for (const reaction of store.find('Reaction', { commentId })) {
    const id = text(reaction, 'id');
    if (id !== undefined) store.remove('Reaction', id);
  }
}

const viaComment = (input: { readonly comment: string }) => ({
  model: 'Comment',
  id: input.comment,
});

// ---------------------------------------------------------------------------------------------
// Mutations

export const commentCreate = defineOperation({
  name: 'comment.create',
  kind: 'mutation',
  domain: 'comment',
  summary: 'Comment on an issue, or reply to a comment',
  description:
    "Adds a comment to an issue (ENG-42 or an id). With parent, a reply in that comment's thread: parent must be a top-level comment of the same issue, not deleted. body is Markdown or editor JSON, at most 50 KB. Archived and deleted issues can't take comments.",
  keywords: ['comment on issue', 'add a comment', 'reply to comment', 'leave a note'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8); generated by the server when absent. */
    id: NewId,
    issue: IssueRef,
    parent: CommentRef.optional(),
    body: CommentBody,
  }),
  output: CommentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { issue: 'ENG-1', body: 'I can reproduce this on **Safari** too.' },
    { issue: 'ENG-1', parent: SEED_THREAD, body: 'Fixed in the latest build.' },
  ],
  ui: { title: 'Comment…', icon: 'message-square', contexts: ['issue'], shortcut: null },
  contentParent: (input) => ({ model: 'Issue', id: input.issue }),
  optimistic: (store, input) => {
    // Markdown is converted by the server: the comment appears when it confirms (§6.2).
    if (input.id === undefined || typeof input.body === 'string') return;
    const issue = liveIssue(store, input.issue);
    const issueId = text(issue, 'id');
    const teamId = text(issue, 'teamId');
    const userId = text(store.get('User', 'me'), 'id');
    if (issueId === undefined || teamId === undefined || userId === undefined) return;
    let parentCommentId: string | null = null;
    if (input.parent !== undefined) {
      const parent = store.get('Comment', input.parent);
      const parentId = text(parent, 'id');
      if (parent === undefined || parentId === undefined) return;
      const problem = replyParentProblem(
        {
          issueId: text(parent, 'issueId') ?? '',
          parentCommentId: text(parent, 'parentCommentId') ?? null,
          deletedAt: parent['deletedAt'],
        },
        issueId,
      );
      if (problem !== undefined) return;
      parentCommentId = parentId;
    }
    const at = store.now.toISOString();
    store.insert('Comment', {
      id: input.id,
      issueId,
      teamId,
      parentCommentId,
      userId,
      actorKind: 'user',
      body: input.body,
      version: 1,
      editedAt: null,
      deletedAt: null,
      resolvedAt: null,
      resolvedById: null,
      createdAt: at,
      updatedAt: at,
    });
  },
});

export const commentUpdate = defineOperation({
  name: 'comment.update',
  kind: 'mutation',
  domain: 'comment',
  summary: 'Edit a comment',
  description:
    'Replaces the text of your own comment. baseVersion is the version you edited from: if the comment changed since, the answer is CONFLICT and nothing is saved. Every edit raises the version and marks the comment edited. body is Markdown or editor JSON, at most 50 KB.',
  keywords: ['edit comment', 'change comment', 'fix my comment', 'update comment text'],
  input: z.object({
    comment: CommentRef,
    baseVersion: z.int('baseVersion must be a whole number, like 1').min(1),
    body: CommentBody,
  }),
  output: CommentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ comment: SEED_THREAD, baseVersion: 1, body: 'Does this happen on **mobile** too?' }],
  ui: { title: 'Edit comment', icon: 'pencil', contexts: ['comment'], shortcut: null },
  contentParent: viaComment,
  optimistic: (store, input) => {
    if (typeof input.body === 'string') return;
    const found = liveComment(store, input.comment);
    if (found === undefined) return;
    const { comment, id } = found;
    // The server refuses these; predicting nothing keeps the overlay equal to what it commits.
    if (isSet(comment['deletedAt'])) return;
    if (text(comment, 'userId') !== text(store.get('User', 'me'), 'id')) return;
    const version = comment['version'];
    if (typeof version !== 'number' || version !== input.baseVersion) return;
    const at = store.now.toISOString();
    // Every update raises the version (§4.3), so a queued follow-up edit carries the right base.
    store.patch('Comment', id, {
      body: input.body,
      version: version + 1,
      editedAt: at,
      updatedAt: at,
    });
  },
});

export const commentDelete = defineOperation({
  name: 'comment.delete',
  kind: 'mutation',
  domain: 'comment',
  summary: 'Delete a comment',
  description:
    'Deletes a comment and its reactions, for good. A comment with replies leaves a "This comment was deleted" placeholder so the replies stay (mode soft); deleting the last reply of a placeholder removes the placeholder too. Your own comments, or any comment as an Admin.',
  keywords: ['delete comment', 'remove comment', 'erase my comment'],
  input: z.object({ comment: CommentRef }),
  output: z.object({ comment: z.uuid(), mode: z.enum(['hard', 'soft']) }),
  permission: (p) => p.any(),
  destructive: true,
  examples: [{ comment: '01930000-0000-7000-8000-000000000704' }],
  ui: { title: 'Delete comment', icon: 'trash', contexts: ['comment'], shortcut: null },
  contentParent: viaComment,
  optimistic: (store, input) => {
    const found = liveComment(store, input.comment);
    if (found === undefined) return;
    const { comment, id } = found;
    // A placeholder is already deleted: the server answers NOT_FOUND.
    if (isSet(comment['deletedAt'])) return;
    // The author or an Admin (permissions §3.3); anyone else is refused, so predict nothing.
    const me = store.get('User', 'me');
    if (text(comment, 'userId') !== text(me, 'id') && me?.['role'] !== 'admin') return;
    removeReactions(store, id);
    const replies = store.find('Comment', { parentCommentId: id });
    if (replies.length > 0) {
      const version = comment['version'];
      if (typeof version !== 'number') return;
      const at = store.now.toISOString();
      store.patch('Comment', id, {
        body: EMPTY_DOC,
        deletedAt: at,
        version: version + 1,
        updatedAt: at,
      });
      return;
    }
    store.remove('Comment', id);
    // The last reply of a placeholder takes the placeholder with it (§4.3).
    const parentId = text(comment, 'parentCommentId');
    const parent = parentId === undefined ? undefined : store.get('Comment', parentId);
    if (parentId !== undefined && parent !== undefined && isSet(parent['deletedAt'])) {
      if (store.find('Comment', { parentCommentId: parentId }).length === 0) {
        removeReactions(store, parentId);
        store.remove('Comment', parentId);
      }
    }
  },
});

/** Resolve and reopen patch the thread's root and leave `version` alone (§4.3). */
function setResolved(store: OptimisticStore, ref: string, resolved: boolean): void {
  const found = liveComment(store, ref);
  if (found === undefined) return;
  const root = threadRoot(store, found.comment);
  const rootId = text(root, 'id');
  if (root === undefined || rootId === undefined) return;
  // Idempotent: the state that already holds changes nothing.
  if (isSet(root['resolvedAt']) === resolved) return;
  const at = store.now.toISOString();
  const by = resolved ? text(store.get('User', 'me'), 'id') : null;
  if (by === undefined) return;
  store.patch('Comment', rootId, {
    resolvedAt: resolved ? at : null,
    resolvedById: by,
    updatedAt: at,
  });
}

export const commentResolve = defineOperation({
  name: 'comment.resolve',
  kind: 'mutation',
  domain: 'comment',
  summary: 'Resolve a comment thread',
  description:
    "Marks a comment's thread resolved, so it collapses to one line. A reply resolves its whole thread. Resolving a resolved thread changes nothing. Anyone who can see the issue may resolve. Returns the thread's first comment.",
  keywords: ['resolve thread', 'mark thread resolved', 'close discussion', 'resolve comment'],
  input: z.object({ comment: CommentRef }),
  output: CommentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ comment: SEED_THREAD }],
  ui: { title: 'Resolve thread', icon: 'check-circle', contexts: ['comment'], shortcut: null },
  contentParent: viaComment,
  optimistic: (store, input) => setResolved(store, input.comment, true),
});

export const commentReopen = defineOperation({
  name: 'comment.reopen',
  kind: 'mutation',
  domain: 'comment',
  summary: 'Reopen a resolved comment thread',
  description:
    "Reopens a resolved thread, so it shows in full again. A reply reopens its whole thread. Reopening an open thread changes nothing. Anyone who can see the issue may reopen. Returns the thread's first comment.",
  keywords: ['reopen thread', 'unresolve thread', 'reopen discussion', 'reopen comment'],
  input: z.object({ comment: CommentRef }),
  output: CommentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ comment: SEED_RESOLVED_THREAD }],
  ui: { title: 'Reopen thread', icon: 'rotate-ccw', contexts: ['comment'], shortcut: null },
  contentParent: viaComment,
  optimistic: (store, input) => setResolved(store, input.comment, false),
});

// ---------------------------------------------------------------------------------------------
// Queries

export const commentList = defineOperation({
  name: 'comment.list',
  kind: 'query',
  domain: 'comment',
  summary: 'List the comments of an issue',
  description:
    "Lists an issue's comments, oldest first, replies included with parentId. Deleted comments that still have replies appear with deleted: true and no body. Bodies come as Markdown and editor JSON. Filters: author (me works), createdAt, editedAt, resolvedAt.",
  keywords: ['list comments', 'read comments', 'issue discussion', 'show replies'],
  input: z.object({ ...listInput, issue: IssueRef }),
  output: connectionOf(CommentOutputSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { issue: 'ENG-1' },
    { issue: 'ENG-1', filter: { field: 'author', op: 'eq', value: 'me' } },
  ],
});
