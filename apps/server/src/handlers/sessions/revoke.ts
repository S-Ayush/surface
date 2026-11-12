// `session.revoke` (SPEC-001 §3.5, AC-8; PLAN-001 S6): ends one of the actor's sessions. The
// executor resolved it (SessionRef: the actor's own, live); its sockets close with `4001` once
// the operation commits. Revoking this session logs this browser out.
import { sessionRevoke } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';
import { actorUserId } from '../users/self.js';

export default handler(sessionRevoke, async (ctx) => {
  const session = resolved(ctx.refs['session'], 'session');
  const ended = await ctx.closeSessions(actorUserId(ctx), { only: session.id });
  return { revoked: ended > 0 };
});
