import { teamSetDefaultStatus } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { workflowAccess } from '../statuses/access.js';
import { setDefaultStatus } from '../statuses/core.js';
import { resolved, teamOutput, teamRef } from './shared.js';

export default handler(teamSetDefaultStatus, async (ctx, input) => {
  const team = teamRef(ctx.refs['team']);
  const { changed } = await setDefaultStatus(workflowAccess(ctx), ctx.repo, {
    teamRef: input.team,
    team,
    statusId: resolved(ctx.refs['status'], 'status').id,
  });
  if (changed) {
    ctx.emit({
      type: 'team.updated',
      subject: { type: 'team', id: team.id },
      changes: { defaultStatusId: { from: changed.from, to: changed.team.defaultStatusId } },
    });
    return teamOutput(changed.team);
  }
  const row = await ctx.query.get('Team', team.id);
  // Locked a moment ago, so gone only if deleted since: worded like any unknown team.
  if (!row) throw refNotFound('TeamRef', input.team, ['team']);
  return teamOutput(row);
});
