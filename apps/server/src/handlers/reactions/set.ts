/** `reaction.set` (SPEC-013 §6.1; PLAN-013 S4): the rules are `core.ts`'s. */
import { reactionSet } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { commentTargetOf, commentWriteContext } from '../comments/access.js';
import { issueTeamOf } from '../issues/shared.js';
import { setReaction } from './core.js';

export default handler(reactionSet, (ctx, input) =>
  setReaction(commentWriteContext(ctx), {
    // The input check guarantees exactly one of the two (§6.3).
    subject:
      input.comment !== undefined
        ? { kind: 'comment', target: commentTargetOf(ctx) }
        : { kind: 'issue', issueId: issueTeamOf(ctx).id },
    emoji: input.emoji,
    reacted: input.reacted,
  }),
);
