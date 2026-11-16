import { issueCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';
import { issueOutput, issueWriteContext } from './access.js';
import { createIssue, descriptionDoc } from './core.js';
import { creatorOf, optionalId, resolvedIds } from './shared.js';

export default handler(issueCreate, async (ctx, input) => {
  // Converted and validated before any lock (§4.3, Q12); `EMPTY_DOC` when absent.
  const description =
    input.description === undefined ? undefined : descriptionDoc(input.description);
  const row = await createIssue(issueWriteContext(ctx), {
    id: input.id ?? uuidv7(),
    team: { id: resolved(ctx.refs['team'], 'team').id },
    teamRef: input.team,
    title: input.title,
    statusId: optionalId(ctx, 'status'),
    statusRef: input.status,
    priority: input.priority,
    assigneeId: optionalId(ctx, 'assignee') ?? null,
    labelIds: resolvedIds(ctx.refs['labels']),
    estimate: input.estimate ?? null,
    dueDate: input.dueDate ?? null,
    creatorId: creatorOf(ctx),
    description,
  });
  return issueOutput(ctx, row);
});
