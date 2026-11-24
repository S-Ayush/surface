/**
 * `issue.listDeleted` (SPEC-015 §3.3, §6.1; PLAN-015 S4): the Recently deleted tab. Deleted issues
 * before their `purgeAfter`, newest deletion first, through `executor/list.ts`, so the actor's sync
 * groups and an API key's `teamIds` apply in SQL before any filter, limit, count or order (§5.3,
 * permissions.md §5). An invisible team named in `team` is `NOT_FOUND` at reference resolution.
 */
import { purgeAfter } from '@surface/domain';
import { issueListDeleted } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutputsWithoutReactions } from './access.js';
import { scoped } from './list.js';
import { deletedIssueListModel } from './list-model.js';

export default handler(issueListDeleted, async (ctx, input) => {
  const page = await ctx.query.list(deletedIssueListModel, {
    ...input,
    ...scoped(ctx, input),
    withTotal: input.withTotal ?? false,
  });
  const outputs = await issueOutputsWithoutReactions(ctx, page.nodes);
  return {
    ...page,
    nodes: outputs.map((issue) => {
      // The model selects deleted issues only, so `deletedAt` is set; the check narrows it.
      if (issue.deletedAt === null) throw new Error(`Issue ${issue.id} is listed but not deleted`);
      return { ...issue, purgeAfter: purgeAfter(issue.deletedAt).toISOString() };
    }),
  };
});
