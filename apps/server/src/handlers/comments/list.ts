/** `comment.list` (SPEC-013 §6.1): one issue's comments, oldest first, replies included. */
import type { Filter } from '@surface/domain';
import { commentList } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueTeamOf } from '../issues/shared.js';
import { commentOutputs } from './access.js';
import { commentListModel } from './list-model.js';

export default handler(commentList, async (ctx, input) => {
  const onIssue: Filter = { field: 'issue', op: 'eq', value: issueTeamOf(ctx).id };
  const page = await ctx.query.list(commentListModel, {
    ...input,
    filter: input.filter === undefined ? onIssue : { and: [onIssue, input.filter] },
  });
  return { ...page, nodes: await commentOutputs(ctx, page.nodes) };
});
