import { labelCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { teamRef } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { createLabel } from './core.js';
import { resolvedGroup } from './resolved-label.js';

export default handler(labelCreate, async (ctx, input) => {
  const row = await createLabel(labelAccess(ctx), ctx.repo, {
    id: input.id ?? uuidv7(),
    teamRef: input.team,
    team: input.team === undefined ? undefined : teamRef(ctx.refs['team']),
    name: input.name,
    color: input.color,
    description: input.description,
    isGroup: input.isGroup,
    exclusive: input.exclusive,
    groupId: input.group === undefined ? undefined : resolvedGroup(ctx).id,
    groupTeamId: input.group === undefined ? undefined : resolvedGroup(ctx).teamId,
  });
  return labelOutput(row);
});
