import { labelDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { teamRef } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { deleteLabel } from './core.js';
import { resolvedLabel } from './resolved-label.js';

export default handler(labelDelete, async (ctx, input) => {
  const { label, removedFromIssues } = await deleteLabel(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: input.team === undefined ? undefined : teamRef(ctx.refs['team']),
    label: resolvedLabel(ctx),
  });
  return { label: labelOutput(label), removedFromIssues };
});
