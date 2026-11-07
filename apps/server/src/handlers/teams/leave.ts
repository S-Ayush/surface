import { teamLeave } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { actorUserId, removeMember, teamRef } from './shared.js';

// SPEC-001 E12: the last member may leave a public team; it stays and can be joined.
export default handler(teamLeave, async (ctx) => {
  const team = teamRef(ctx.refs['team']);
  return removeMember(
    ctx,
    team,
    actorUserId(ctx, 'leave a team'),
    `You are the last member of ${team.key}, a private team. Add someone else before you leave.`,
  );
});
