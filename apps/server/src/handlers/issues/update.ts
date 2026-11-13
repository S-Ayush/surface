import { issueUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutput, issueWriteContext } from './access.js';
import { updateIssue } from './core.js';
import { issueTeamOf, optionalId, resolvedIds } from './shared.js';

export default handler(issueUpdate, async (ctx, input) => {
  const issue = issueTeamOf(ctx);
  const { row } = await updateIssue(issueWriteContext(ctx), {
    issueId: issue.id,
    teamId: issue.teamId,
    title: input.title,
    statusId: optionalId(ctx, 'status'),
    statusRef: input.status,
    priority: input.priority,
    // `null` clears the assignee; the executor resolves only a present one.
    assigneeId: input.assignee === null ? null : optionalId(ctx, 'assignee'),
    estimate: input.estimate,
    dueDate: input.dueDate,
    addLabelIds: resolvedIds(ctx.refs['addLabels']),
    removeLabelIds: resolvedIds(ctx.refs['removeLabels']),
  });
  return issueOutput(ctx, row);
});
