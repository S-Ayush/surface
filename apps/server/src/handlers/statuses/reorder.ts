import { statusReorder } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { resolved, teamRef } from '../teams/shared.js';
import { statusOutput, workflowAccess } from './access.js';
import { reorderStatus } from './core.js';

export default handler(statusReorder, async (ctx, input) => {
  const idOf = (field: 'before' | 'after') =>
    input[field] === undefined ? undefined : resolved(ctx.refs[field], field).id;
  const row = await reorderStatus(workflowAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: teamRef(ctx.refs['team']),
    statusId: resolved(ctx.refs['status'], 'status').id,
    before: idOf('before'),
    after: idOf('after'),
  });
  return statusOutput(row);
});
