import { labelUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { teamRef } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { updateLabel } from './core.js';
import { resolvedGroup, resolvedLabel } from './resolved-label.js';

export default handler(labelUpdate, async (ctx, input) => {
  const row = await updateLabel(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: input.team === undefined ? undefined : teamRef(ctx.refs['team']),
    label: resolvedLabel(ctx),
    name: input.name,
    color: input.color,
    description: input.description,
    exclusive: input.exclusive,
    groupId:
      input.group === undefined || input.group === null ? input.group : resolvedGroup(ctx).id,
    groupTeamId:
      input.group === undefined || input.group === null ? undefined : resolvedGroup(ctx).teamId,
  });
  return labelOutput(row);
});
