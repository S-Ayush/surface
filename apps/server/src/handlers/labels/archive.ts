import { labelArchive } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { teamRef } from '../teams/shared.js';
import { labelAccess, labelOutput } from './access.js';
import { archiveLabel } from './core.js';
import { resolvedLabel } from './resolved-label.js';

// PLAN-010 S6: the repo's archive path logs `A`/`V` with the row (SPEC-011 §5.5).
export default handler(labelArchive, async (ctx, input) => {
  const row = await archiveLabel(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team: input.team === undefined ? undefined : teamRef(ctx.refs['team']),
    label: resolvedLabel(ctx),
  });
  return labelOutput(row);
});
