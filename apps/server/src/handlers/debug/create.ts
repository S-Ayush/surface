import { debugCreate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { debugItemOutput } from './item.js';

export default handler(debugCreate, async (ctx, input) => {
  const row = await ctx.repo.insert('DebugItem', {
    id: input.id,
    title: input.title,
    syncGroups: input.groups,
  });
  return debugItemOutput(row);
});
