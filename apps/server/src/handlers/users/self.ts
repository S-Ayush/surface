// The "self" operations of SPEC-001 §6.2 (PLAN-001 S6): each acts on the signed-in user only.
import type { HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';

/** The actor's user id; the system actor has no account of its own. */
export function actorUserId(ctx: Pick<HandlerContext, 'actor'>): string {
  const userId = ctx.actor.userId;
  if (userId === undefined) {
    throw new SurfaceError('FORBIDDEN', 'Only a signed-in person has an account to change.');
  }
  return userId;
}
