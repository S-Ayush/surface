import { debugRename } from '@surface/operations';
import { SurfaceError } from '../../executor/errors.js';
import { handler } from '../../executor/context.js';
import { debugItemOutput } from './item.js';

export default handler(debugRename, async (ctx, input) => {
  // Visibility first: an item the actor can't see is NOT_FOUND.
  const item = await ctx.query.get('DebugItem', input.id);
  if (!item) throw new SurfaceError('NOT_FOUND', `Debug item ${input.id} not found.`);
  return debugItemOutput(await ctx.repo.update('DebugItem', item.id, { title: input.title }));
});
