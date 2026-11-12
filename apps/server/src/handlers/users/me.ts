// `user.me` (SPEC-001 §6.2; PLAN-001 S6): the signed-in user, as `user.get` with "me" answers.
import { userMe } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { userOutput } from '../members/shared.js';
import { actorUserId } from './self.js';

export default handler(userMe, async (ctx) => {
  const user = await ctx.query.get('User', actorUserId(ctx));
  if (!user) throw new SurfaceError('NOT_FOUND', 'Your account was not found. Log in again.');
  return userOutput(user);
});
