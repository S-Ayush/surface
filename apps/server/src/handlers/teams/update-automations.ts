import { teamUpdateAutomations } from '@surface/operations';
import { eq } from 'drizzle-orm';
import { teams, workflowStatuses } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { updateAutomations } from './automations.js';
import { resolved, teamOutput, teamRef } from './shared.js';

export default handler(teamUpdateAutomations, async (ctx, input) => {
  const team = teamRef(ctx.refs['team']);
  const { team: row, changes } = await updateAutomations(
    {
      async lockTeam(teamId) {
        const [locked] = await ctx.tx
          .select()
          .from(teams)
          .where(eq(teams.id, teamId))
          .for('update');
        return locked;
      },
      statuses: (teamId) =>
        ctx.tx
          .select({
            id: workflowStatuses.id,
            name: workflowStatuses.name,
            category: workflowStatuses.category,
            position: workflowStatuses.position,
          })
          .from(workflowStatuses)
          .where(eq(workflowStatuses.teamId, teamId)),
    },
    ctx.repo,
    {
      teamRef: input.team,
      teamId: team.id,
      autoArchiveMonths: input.autoArchiveMonths,
      autoCloseMonths: input.autoCloseMonths,
      statusId:
        ctx.refs['autoCloseStatus'] === undefined
          ? undefined
          : resolved(ctx.refs['autoCloseStatus'], 'autoCloseStatus').id,
    },
  );
  if (Object.keys(changes).length > 0) {
    ctx.emit({ type: 'team.updated', subject: { type: 'team', id: team.id }, changes });
  }
  return teamOutput(row);
});
