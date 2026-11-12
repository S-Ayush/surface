// `session.revokeOthers` (SPEC-001 §3.5, AC-8; PLAN-001 S6): ends every session of the actor
// but this one; their sockets close with `4001` once the operation commits.
import { sessionRevokeOthers } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { actorUserId } from '../users/self.js';

export default handler(sessionRevokeOthers, async (ctx) => {
  const sessionId = ctx.actor.sessionId;
  // An actor without a session (an API key, M6) has no "this one" to keep.
  const revoked = await ctx.closeSessions(
    actorUserId(ctx),
    sessionId === undefined ? { all: true } : { except: sessionId },
  );
  return { revoked };
});
