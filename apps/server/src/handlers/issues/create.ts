import { issueCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';
import { issueOutput, issueWriteContext } from './access.js';
import { createIssue } from './core.js';
import { creatorOf, optionalId, resolvedIds } from './shared.js';

export default handler(issueCreate, async (ctx, input) => {
  const row = await createIssue(issueWriteContext(ctx), {
    id: input.id ?? uuidv7(),
    team: { id: resolved(ctx.refs['team'], 'team').id },
    teamRef: input.team,
    title: input.title,
    statusId: optionalId(ctx, 'status'),
    priority: input.priority,
    assigneeId: optionalId(ctx, 'assignee') ?? null,
    labelIds: resolvedIds(ctx.refs['labels']),
    estimate: input.estimate ?? null,
    dueDate: input.dueDate ?? null,
    creatorId: creatorOf(ctx),
  });
  return issueOutput(ctx.tx, row);
});
