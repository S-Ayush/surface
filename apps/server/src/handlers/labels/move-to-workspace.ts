import { labelMoveToWorkspace } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { teamRef } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { moveLabelToWorkspace } from './core.js';
import { resolvedLabel } from './resolved-label.js';

export default handler(labelMoveToWorkspace, async (ctx, input) => {
  const row = await moveLabelToWorkspace(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: teamRef(ctx.refs['team']),
    label: resolvedLabel(ctx),
  });
  return labelOutput(row);
});
