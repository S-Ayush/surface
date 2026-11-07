import { teamRemoveMember } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { removeMember, resolved, teamRef } from './shared.js';

export default handler(teamRemoveMember, async (ctx) => {
  const team = teamRef(ctx.refs['team']);
  return removeMember(
    ctx,
    team,
    resolved(ctx.refs['user'], 'user').id,
    `${team.key} is a private team and this is its last member. Add someone else first.`,
  );
});
