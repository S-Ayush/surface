import { userCreateResetLink } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { resolved } from '../teams/shared.js';

// An Admin's reset link (SPEC-001 §3.3): the way back in when the server sends no email (AC-3).
// The executor checked `p.admin()` and resolved the user (active users only). The link is stored
// on this operation's transaction, so a rolled-back operation leaves no working link.
export default handler(userCreateResetLink, async (ctx) => {
  const user = resolved(ctx.refs['user'], 'user');
  const link = await ctx.links.passwordReset(user.id);
  if (link === undefined)
    throw new SurfaceError('NOT_FOUND', 'No such user. Check the email or display name.');
  ctx.log.info({ event: 'user.reset_link_created', userId: user.id }, 'reset link created');
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
});
