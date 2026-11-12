import { statusUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { resolved, teamRef } from '../teams/shared.js';
import { statusOutput, workflowAccess } from './access.js';
import { updateStatus } from './core.js';

export default handler(statusUpdate, async (ctx, input) => {
  const row = await updateStatus(workflowAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: teamRef(ctx.refs['team']),
    statusId: resolved(ctx.refs['status'], 'status').id,
    name: input.name,
    color: input.color,
    description: input.description,
  });
  return statusOutput(row);
});
