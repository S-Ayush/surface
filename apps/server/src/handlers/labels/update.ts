import { labelUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { updateLabel } from './core.js';
import { resolvedLabel } from './resolved-label.js';

export default handler(labelUpdate, async (ctx, input) => {
  const row = await updateLabel(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    label: resolvedLabel(ctx),
    name: input.name,
    color: input.color,
    description: input.description,
    exclusive: input.exclusive,
    groupId:
      input.group === undefined || input.group === null
        ? input.group
        : resolved(ctx.refs['group'], 'group').id,
  });
  return labelOutput(row);
});
