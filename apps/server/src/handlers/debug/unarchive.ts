import { debugUnarchive } from '@surface/operations';
import { SurfaceError } from '../../executor/errors.js';
import { handler } from '../../executor/context.js';
import { debugItemOutput } from './item.js';

// PLAN-011 S2: the repo logs a `V` that carries the full row (SPEC-011 §5.5).
export default handler(debugUnarchive, async (ctx, input) => {
  // Visibility first: an item the actor can't see is NOT_FOUND.
  const item = await ctx.query.get('DebugItem', input.id);
  if (!item) throw new SurfaceError('NOT_FOUND', `Debug item ${input.id} not found.`);
  return debugItemOutput(await ctx.repo.unarchive('DebugItem', item.id));
});
