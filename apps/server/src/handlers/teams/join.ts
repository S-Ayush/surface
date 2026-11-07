import { teamJoin } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { actorUserId, addMember, teamRef } from './shared.js';

// Anyone may join a team they can see (permissions.md §3.2): a private team is visible only to
// its members, so the executor answers NOT_FOUND to everyone else before this runs.
export default handler(teamJoin, async (ctx) =>
  addMember(ctx, teamRef(ctx.refs['team']), actorUserId(ctx, 'join a team')),
);
