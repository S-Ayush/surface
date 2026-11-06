import { debugDelete } from '@surface/operations';
import { SurfaceError } from '../../executor/errors.js';
import { handler } from '../../executor/context.js';

export default handler(debugDelete, async (ctx, input) => {
  // Visibility first: an item the actor can't see is NOT_FOUND.
  const item = await ctx.query.get('DebugItem', input.id);
  if (!item) throw new SurfaceError('NOT_FOUND', `Debug item ${input.id} not found.`);
  await ctx.repo.purge('DebugItem', item.id);
  return { id: item.id };
});
