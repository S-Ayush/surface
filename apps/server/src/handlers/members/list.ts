import { userList } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { userListModel, userOutput } from './shared.js';

export default handler(userList, async (ctx, input) => {
  const page = await ctx.query.list(userListModel, input);
  return { ...page, nodes: page.nodes.map(userOutput) };
});
