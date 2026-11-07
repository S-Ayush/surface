import { teamAddMember } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { addMember, resolved, teamRef } from './shared.js';

export default handler(teamAddMember, async (ctx) =>
  addMember(ctx, teamRef(ctx.refs['team']), resolved(ctx.refs['user'], 'user').id),
);
