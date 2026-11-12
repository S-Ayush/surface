import { statusCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { resolved, teamRef } from '../teams/shared.js';
import { statusOutput, workflowAccess } from './access.js';
import { createStatus } from './core.js';

export default handler(statusCreate, async (ctx, input) => {
  const row = await createStatus(workflowAccess(ctx), ctx.repo, {
    id: input.id ?? uuidv7(),
    teamRef: input.team,
    team: teamRef(ctx.refs['team']),
    name: input.name,
    category: input.category,
    color: input.color,
    description: input.description,
    after: input.after === undefined ? undefined : resolved(ctx.refs['after'], 'after').id,
  });
  return statusOutput(row);
});
