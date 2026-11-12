import { statusDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { resolved, teamRef } from '../teams/shared.js';
import { statusOutput, workflowAccess } from './access.js';
import { deleteStatus } from './core.js';

export default handler(statusDelete, async (ctx, input) => {
  const row = await deleteStatus(workflowAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: teamRef(ctx.refs['team']),
    statusId: resolved(ctx.refs['status'], 'status').id,
  });
  return statusOutput(row);
});
