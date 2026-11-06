import { debugTouch } from '@surface/operations';
import { sql } from 'drizzle-orm';
import { debugItems } from '../../db/schema/index.js';
import { SurfaceError } from '../../executor/errors.js';
import { handler } from '../../executor/context.js';

export default handler(debugTouch, async (ctx, input) => {
  // Visibility first: an item the actor can't see is NOT_FOUND, like any other invisible row.
  const item = await ctx.query.get('DebugItem', input.id);
  if (!item) throw new SurfaceError('NOT_FOUND', `Debug item ${input.id} not found.`);

  // Increment in SQL, so concurrent touches never lose an update (AC-12).
  const touched = await ctx.repo.update('DebugItem', item.id, {
    counter: sql`${debugItems.counter} + 1`,
  });
  ctx.emit({
    type: 'debug.touched',
    subject: { type: 'debug_item', id: touched.id },
    // `item.counter` may be stale under concurrent touches; the increment is exactly one.
    changes: { counter: { from: touched.counter - 1, to: touched.counter } },
  });
  return {
    id: touched.id,
    title: touched.title,
    counter: touched.counter,
    updatedAt: touched.updatedAt.toISOString(),
  };
});
