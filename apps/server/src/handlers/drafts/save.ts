// `draft.save` (SPEC-012 §4.3, PLAN-012 S5): upserts the actor's draft by its key.
import { draftKeyOf, draftSave } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { draftAccess, draftOutput } from './access.js';
import { draftOwner, saveDraft } from './core.js';

export default handler(draftSave, async (ctx, input) => {
  const userId = draftOwner(ctx.actor);
  // The input schema checked the key (`draftKeyProblem`), so this is always defined.
  const key = draftKeyOf(input);
  if (key === undefined) throw new Error('draft.save input passed without its key');
  const row = await saveDraft(draftAccess(ctx), ctx.repo, userId, {
    key,
    data: input.data,
    newId: input.id ?? uuidv7(),
  });
  return draftOutput(row);
});
