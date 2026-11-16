/**
 * `reaction.set` (SPEC-013 §6.1, D1, D8; PLAN-013 S4): set or clear the caller's emoji on a
 * comment or on the issue itself. Idempotent: the id is `reactionId(subject, user, emoji)` on both
 * sides, and setting the state that already holds changes nothing. At most 20 distinct emoji per
 * subject (D15). Anyone who can see the issue may react (§5.2); visibility is the executor's
 * check on each reference, so a comment or issue the caller can't see is `NOT_FOUND`.
 *
 * The input checks that `emoji` is one RGI emoji (`isSingleEmoji`, §4.4 "The client checks the
 * same"), so the optimistic update never predicts a row the server refuses.
 *
 * `contentParent` (SPEC-011 §5.3 step 6): `{ model: 'Comment', id }` for a comment's reaction, as
 * the comment operations declare (the client reads the comment's issue), and the issue otherwise.
 */
import {
  CommentRef,
  IssueRef,
  isSet,
  isSingleEmoji,
  REACTION_MESSAGES,
  reactionCapProblem,
  reactionId,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import type { OptimisticStore } from '../optimistic.js';
import { liveIssue, text } from './content-store.js';

// A fixed id of the seed fixture's first thread on ENG-1 (`apps/server/test/seed.ts`).
const SEED_THREAD = '01930000-0000-7000-8000-000000000701';

/**
 * A subject's reactions as chips (SPEC-013 §6.1): one per emoji, in the order it was first set.
 * `CommentOutput.reactions` and `IssueOutput.reactions` (SPEC-011 §6.1) both use it, built with
 * `summariseReactions` from domain.
 */
export const ReactionSummariesSchema = z.array(
  z.object({ emoji: z.string(), count: z.int().min(1), mine: z.boolean() }),
);

/** What `reaction.set` reacted to. */
export const ReactionTargetSchema = z.object({
  type: z.enum(['comment', 'issue']),
  id: z.uuid(),
});

/** The emoji's chip on its subject after the call (§6.1): `count` is 0 once nobody has it. */
export const ReactionSetOutputSchema = z.object({
  target: ReactionTargetSchema,
  emoji: z.string(),
  count: z.int().min(0),
  mine: z.boolean(),
});

/** The subject's fields a reaction row copies, or undefined when the server would refuse. */
function subjectOf(
  store: OptimisticStore,
  input: { readonly comment?: string | undefined; readonly issue?: string | undefined },
):
  | {
      readonly subjectId: string;
      readonly issueId: string;
      readonly teamId: string;
      readonly commentId: string | null;
    }
  | undefined {
  if (input.comment !== undefined) {
    const comment = store.get('Comment', input.comment);
    const id = text(comment, 'id');
    const issueId = text(comment, 'issueId');
    const teamId = text(comment, 'teamId');
    // A placeholder takes no reactions (§4.3: NOT_FOUND).
    if (comment === undefined || id === undefined || isSet(comment['deletedAt'])) return undefined;
    if (issueId === undefined || teamId === undefined) return undefined;
    if (liveIssue(store, issueId) === undefined) return undefined;
    return { subjectId: id, issueId, teamId, commentId: id };
  }
  if (input.issue === undefined) return undefined;
  const issue = liveIssue(store, input.issue);
  const issueId = text(issue, 'id');
  const teamId = text(issue, 'teamId');
  if (issueId === undefined || teamId === undefined) return undefined;
  return { subjectId: issueId, issueId, teamId, commentId: null };
}

export const reactionSet = defineOperation({
  name: 'reaction.set',
  kind: 'mutation',
  // domain-model §7: reactions belong to the comment domain (`domains.ts`).
  domain: 'comment',
  summary: 'React to a comment or an issue with an emoji',
  description:
    'Sets (reacted: true) or clears (reacted: false) your emoji reaction on a comment, or on the issue itself (ENG-42 or an id). Give exactly one of comment and issue. emoji is one emoji, like 👍. Setting what already holds changes nothing. A comment, and an issue, take at most 20 different emoji. Archived and deleted issues take no reactions.',
  keywords: ['add reaction', 'react with emoji', 'remove reaction', 'thumbs up', 'emoji reaction'],
  input: z
    .object({
      comment: CommentRef.optional(),
      issue: IssueRef.optional(),
      emoji: z
        .string(REACTION_MESSAGES.notOneEmoji)
        .min(1, REACTION_MESSAGES.notOneEmoji)
        .max(64, REACTION_MESSAGES.notOneEmoji)
        .refine(isSingleEmoji, REACTION_MESSAGES.notOneEmoji),
      reacted: z.boolean('reacted must be true (set) or false (clear)'),
    })
    .superRefine((input, ctx) => {
      if ((input.comment === undefined) === (input.issue === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['comment'], message: REACTION_MESSAGES.subject });
      }
    }),
  output: ReactionSetOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { comment: SEED_THREAD, emoji: '👍', reacted: true },
    { issue: 'ENG-1', emoji: '🚀', reacted: true },
  ],
  ui: {
    title: 'Add reaction…',
    icon: 'smile-plus',
    contexts: ['comment', 'issue'],
    shortcut: null,
  },
  contentParent: (input) =>
    input.comment !== undefined
      ? { model: 'Comment', id: input.comment }
      : // The refine above makes `issue` present here; the type can't say so.
        { model: 'Issue', id: input.issue ?? '' },
  optimistic: (store, input) => {
    const subject = subjectOf(store, input);
    const userId = text(store.get('User', 'me'), 'id');
    if (subject === undefined || userId === undefined) return;
    const id = reactionId(subject.subjectId, userId, input.emoji);
    const held = store.get('Reaction', id) !== undefined;
    // Idempotent (E5): the state that already holds changes nothing.
    if (held === input.reacted) return;
    if (!input.reacted) {
      store.remove('Reaction', id);
      return;
    }
    const rows = store.find('Reaction', {
      issueId: subject.issueId,
      commentId: subject.commentId,
    });
    const emoji = rows.flatMap((row) => {
      const value = text(row, 'emoji');
      return value === undefined ? [] : [{ emoji: value }];
    });
    // The 21st distinct emoji is refused (D15): predict nothing.
    if (reactionCapProblem(emoji, input.emoji) !== undefined) return;
    store.insert('Reaction', {
      id,
      issueId: subject.issueId,
      teamId: subject.teamId,
      commentId: subject.commentId,
      userId,
      emoji: input.emoji,
      createdAt: store.now.toISOString(),
    });
  },
});
