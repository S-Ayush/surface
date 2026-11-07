import { userGet } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { resolved } from '../teams/shared.js';
import { userOutput } from './shared.js';

export default handler(userGet, async (ctx, input) => {
  const ref = resolved(ctx.refs['user'], 'user');
  const user = await ctx.query.get('User', ref.id);
  // Resolved at step 7; gone only if deleted since. Same words as the resolver's.
  if (!user) throw refNotFound('UserRef', input.user, ['user']);
  return userOutput(user);
});
