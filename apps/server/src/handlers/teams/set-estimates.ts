import { teamSetEstimates } from '@surface/operations';
import { eq } from 'drizzle-orm';
import { teams } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { setEstimates } from './estimates.js';
import { teamOutput, teamRef } from './shared.js';

export default handler(teamSetEstimates, async (ctx, input) => {
  const team = teamRef(ctx.refs['team']);
  const { team: row, changes } = await setEstimates(
    {
      async lockTeam(teamId) {
        const [locked] = await ctx.tx
          .select()
          .from(teams)
          .where(eq(teams.id, teamId))
          .for('update');
        return locked;
      },
    },
    ctx.repo,
    {
      teamRef: input.team,
      teamId: team.id,
      scale: input.scale,
      extended: input.extended,
      allowZero: input.allowZero,
      countUnestimatedAsOne: input.countUnestimatedAsOne,
    },
  );
  if (Object.keys(changes).length > 0) {
    ctx.emit({ type: 'team.updated', subject: { type: 'team', id: team.id }, changes });
  }
  return teamOutput(row);
});
