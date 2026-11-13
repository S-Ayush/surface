// `draft.discard` (SPEC-012 §4.3, PLAN-012 S5): deletes the actor's draft with this key, if any.
import { draftDiscard, draftKeyOf } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { draftAccess } from './access.js';
import { discardDraft, draftOwner } from './core.js';

export default handler(draftDiscard, async (ctx, input) => {
  const userId = draftOwner(ctx.actor);
  const key = draftKeyOf(input);
  if (key === undefined) throw new Error('draft.discard input passed without its key');
  return { discarded: await discardDraft(draftAccess(ctx), ctx.repo, userId, key) };
});
