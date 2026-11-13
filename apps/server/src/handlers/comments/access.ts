/**
 * `CommentAccess` over the operation's Postgres transaction, and the comment output shape
 * (SPEC-013 §6.1). The rows an output names (issue, team, users, reactions) are read in one query
 * each for a whole page; every one is visible to whoever sees the comment: its issue (the comment
 * is visible only through it), the issue's team, and users, who are workspace-wide.
 */
import {
  issueIdentifier,
  type CommentActorKind,
  type DocNodeJSON,
  type RefEntity,
} from '@surface/domain';
import { docToMarkdown } from '@surface/editor/schema';
import type { CommentOutputSchema } from '@surface/operations';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  comments,
  commentSearchText,
  issues,
  reactions,
  teams,
  users,
} from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { claimInlineFiles } from '../../files/claim.js';
import { lockIssueForWrite } from '../../issues/lifecycle.js';
import { resolved } from '../teams/shared.js';
import type {
  CommentAccess,
  CommentAuthor,
  CommentRow,
  CommentTarget,
  CommentWriteContext,
} from './core.js';

type CommentOutput = z.input<typeof CommentOutputSchema>;

export function commentAccess(ctx: HandlerContext): CommentAccess {
  const { tx } = ctx;
  return {
    lockIssue: (issueId, mode) => lockIssueForWrite(tx, issueId, { actor: ctx.actor }, mode),
    async lockComment(commentId) {
      const [row] = await tx
        .select()
        .from(comments)
        .where(eq(comments.id, commentId))
        .for('update');
      return row;
    },
    async readComment(commentId) {
      const [row] = await tx.select().from(comments).where(eq(comments.id, commentId));
      return row;
    },
    async replyIds(rootId) {
      const rows = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.parentCommentId, rootId))
        .orderBy(asc(comments.id));
      return rows.map((r) => r.id);
    },
    async setSearchText(commentId, text) {
      // Server-only (D2): plain SQL in the comment's transaction.
      if (text === null) {
        await tx.delete(commentSearchText).where(eq(commentSearchText.commentId, commentId));
        return;
      }
      await tx
        .insert(commentSearchText)
        .values({ commentId, text })
        .onConflictDoUpdate({ target: commentSearchText.commentId, set: { text } });
    },
    claimFiles: (doc, issue) => claimInlineFiles(tx, doc, issue, ctx.actor),
  };
}

/** The author of a write: the user, or for `api` and `mcp` the key's owner (§4.1, D16). */
export function commentAuthorOf(ctx: HandlerContext): CommentAuthor {
  const { userId, kind } = ctx.actor;
  if (userId === undefined || kind === 'system') {
    throw new SurfaceError('FORBIDDEN', 'Only a signed-in user or an API key can comment.');
  }
  const actorKind: CommentActorKind = kind;
  return { userId, actorKind, admin: ctx.actor.role === 'admin' };
}

/** The write context the comment rules run with. */
export function commentWriteContext(ctx: HandlerContext): CommentWriteContext {
  return {
    access: commentAccess(ctx),
    repo: ctx.repo,
    emit: (event) => ctx.emit(event),
    now: ctx.now(),
    author: commentAuthorOf(ctx),
  };
}

/** The comment a resolved `CommentRef` (input field `field`) names, and its thread's root. */
export function commentTargetOf(ctx: HandlerContext, field = 'comment'): CommentTarget {
  const row: RefEntity = resolved(ctx.refs[field], field);
  const issueId = row['issueId'];
  const parentId = row['parentCommentId'];
  if (typeof issueId !== 'string' || (parentId !== null && typeof parentId !== 'string')) {
    throw new Error('Comment reference is missing issueId or parentCommentId');
  }
  return { commentId: row.id, issueId, rootId: parentId ?? row.id };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Stored bodies passed `validateDoc` on write (§4.4); this only narrows the `jsonb` type. */
function isDoc(value: unknown): value is DocNodeJSON {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'doc';
}

/** The full output of each row, in the rows' order (§6.1). `viewerId` decides `mine`. */
export async function commentOutputs(
  ctx: Pick<HandlerContext, 'tx' | 'actor'>,
  rows: readonly CommentRow[],
): Promise<CommentOutput[]> {
  if (rows.length === 0) return [];
  const { tx } = ctx;
  const viewerId = ctx.actor.userId ?? null;
  const unique = (ids: (string | null)[]) => [
    ...new Set(ids.filter((id): id is string => id !== null)),
  ];
  const issueIds = unique(rows.map((r) => r.issueId));
  const userIds = unique(rows.flatMap((r) => [r.userId, r.resolvedById]));
  const commentIds = rows.map((r) => r.id);

  const issueRows = await tx
    .select({ id: issues.id, number: issues.number, key: teams.key })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(inArray(issues.id, issueIds));
  const userRows = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, userIds));
  // Reactions are rows of the comment's issue, so whoever sees the comment sees them (§5.1).
  const reactionRows = await tx
    .select({
      commentId: reactions.commentId,
      emoji: reactions.emoji,
      count: sql<number>`count(*)::int`,
      mine: sql<boolean>`coalesce(bool_or(${reactions.userId} = ${viewerId}::uuid), false)`,
    })
    .from(reactions)
    .where(inArray(reactions.commentId, commentIds))
    .groupBy(reactions.commentId, reactions.emoji)
    .orderBy(sql`min(${reactions.createdAt})`, asc(reactions.emoji));

  const identifiers = new Map(
    issueRows.map((i) => [i.id, issueIdentifier(i.key, i.number ?? 0)] as const),
  );
  const names = new Map(userRows.map((u) => [u.id, u.name]));
  const person = (id: string) => {
    const name = names.get(id);
    // Users are never purged (permissions §6, E8): a miss is a bug, never input.
    if (name === undefined) throw new Error(`Comment output names a missing user ${id}`);
    return { id, name };
  };

  return rows.map((row) => {
    const identifier = identifiers.get(row.issueId);
    if (identifier === undefined) throw new Error(`Comment ${row.id} names a missing issue`);
    const deleted = row.deletedAt !== null;
    if (!deleted && !isDoc(row.body)) throw new Error(`Comment ${row.id} has no document body`);
    return {
      id: row.id,
      issue: { id: row.issueId, identifier },
      parentId: row.parentCommentId,
      author: person(row.userId),
      actorKind: row.actorKind,
      // A placeholder shows "This comment was deleted": no body (§4.3).
      body:
        deleted || !isDoc(row.body)
          ? null
          : { markdown: docToMarkdown(row.body), json: { ...row.body } },
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      editedAt: iso(row.editedAt),
      deleted,
      resolved:
        row.resolvedAt === null || row.resolvedById === null
          ? null
          : { at: row.resolvedAt.toISOString(), by: person(row.resolvedById) },
      reactions: reactionRows
        .filter((r) => r.commentId === row.id)
        .map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
    };
  });
}

/** One row's full output. */
export async function commentOutput(
  ctx: Pick<HandlerContext, 'tx' | 'actor'>,
  row: CommentRow,
): Promise<CommentOutput> {
  const [output] = await commentOutputs(ctx, [row]);
  if (output === undefined) throw new Error(`No output for comment ${row.id}`);
  return output;
}
