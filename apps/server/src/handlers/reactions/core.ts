/**
 * The rules of `reaction.set` (SPEC-013 §4.2, §4.3, §6.1, §6.3, D1, D8, D15; PLAN-013 S4), written
 * against the comment rules' `CommentAccess` and the repo, so the unit tests run them in memory
 * and the handler runs them on Postgres (`comments/access.ts`).
 *
 * Order of work (§4.3): the issue row in the operation's lock mode (`edit`: archived and deleted
 * issues are `CONFLICT`, D10), then for a comment's reaction the thread's root `FOR UPDATE`, then
 * the subject's reactions are re-read under those locks, then at most one write through the repo.
 * An issue's own reactions take the issue lock only. Two tabs setting the same emoji (E5) and two
 * people racing the 20-emoji cap (E14) are serialized by those locks. Reactions write no history
 * (D24); events carry ids, never content.
 */
import {
  isSet,
  isSingleEmoji,
  issueLockModeOf,
  REACTION_MESSAGES,
  reactionCapProblem,
  reactionId,
} from '@surface/domain';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import {
  lockTarget,
  type CommentTarget,
  type CommentWriteContext,
  type ReactionRow,
} from '../comments/core.js';

/** A resolved `reaction.set` input: the comment (as its `CommentRef` named it) or the issue. */
export type ReactionSubject =
  | { readonly kind: 'comment'; readonly target: CommentTarget }
  | { readonly kind: 'issue'; readonly issueId: string };

export interface SetReactionInput {
  readonly subject: ReactionSubject;
  readonly emoji: string;
  readonly reacted: boolean;
}

export interface SetReactionResult {
  readonly target: { readonly type: 'comment' | 'issue'; readonly id: string };
  readonly emoji: string;
  /** How many people have `emoji` on the subject after the call (0 when nobody has). */
  readonly count: number;
  readonly mine: boolean;
}

function invalid(field: string, message: string) {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path: [field], message }] });
}

/** `reaction.set` (§6.1): sets or clears the author's `emoji` on a comment or on the issue. */
export async function setReaction(
  ctx: CommentWriteContext,
  input: SetReactionInput,
): Promise<SetReactionResult> {
  // §4.4 "Emoji": exactly one RGI emoji, the same rule the web app's emoji data passes (AC-15).
  // The operation's input schema checks it first; this keeps the rule for direct callers.
  if (!isSingleEmoji(input.emoji)) throw invalid('emoji', REACTION_MESSAGES.notOneEmoji);
  const mode = issueLockModeOf('reaction.set');
  let issueId: string;
  let teamId: string;
  let commentId: string | null;
  if (input.subject.kind === 'comment') {
    const { issue, comment } = await lockTarget(ctx, input.subject.target, 'reaction.set');
    // A placeholder takes no reactions (§4.3): as if it were gone.
    if (isSet(comment.deletedAt)) {
      throw refNotFound('CommentRef', input.subject.target.commentId, ['comment']);
    }
    issueId = issue.id;
    teamId = issue.teamId;
    commentId = comment.id;
  } else {
    const issue = await ctx.access.lockIssue(input.subject.issueId, mode);
    issueId = issue.id;
    teamId = issue.teamId;
    commentId = null;
  }
  const subjectId = commentId ?? issueId;
  const type = commentId === null ? 'issue' : 'comment';
  const userId = ctx.author.userId;
  const id = reactionId(subjectId, userId, input.emoji);

  // Re-read under the locks (§4.3 step 3).
  const rows = await ctx.access.reactionsOn(issueId, commentId);
  const held = rows.some((row) => row.id === id);
  const others = rows.filter((row) => row.emoji === input.emoji && row.id !== id).length;
  const result = (mine: boolean): SetReactionResult => ({
    target: { type, id: subjectId },
    emoji: input.emoji,
    count: others + (mine ? 1 : 0),
    mine,
  });
  // Idempotent (E5): the state that already holds changes nothing, no write, no event.
  if (held === input.reacted) return result(held);

  const event = {
    subject: { type: 'reaction', id },
    data: { issueId, commentId, emoji: input.emoji },
  };
  if (input.reacted) {
    const problem = reactionCapProblem(rows, input.emoji);
    if (problem !== undefined) throw invalid('emoji', problem);
    const row: Omit<ReactionRow, 'syncGroups' | 'createdAt'> = {
      id,
      issueId,
      // The repo stores the issue row's team whatever is passed (SPEC-011 §5.1, D4).
      teamId,
      commentId,
      userId,
      emoji: input.emoji,
    };
    await ctx.repo.insert('Reaction', row);
    ctx.emit({ type: 'reaction.added', ...event });
  } else {
    await ctx.repo.purge('Reaction', id);
    ctx.emit({ type: 'reaction.removed', ...event });
  }
  return result(input.reacted);
}
