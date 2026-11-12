// `user.changePassword` (SPEC-001 §3.5, E10; PLAN-001 S6): after checking the current password,
// sets the new one and ends the user's other sessions; their sockets close with `4001` once the
// operation commits. This session stays signed in.
import { userChangePassword } from '@surface/operations';
import { eq } from 'drizzle-orm';
import { accountKey } from '../../auth/attempts.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { userCredentials } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { actorUserId } from './self.js';

export const WRONG_CURRENT_PASSWORD = 'Your current password is not right. Check it and try again.';

export default handler(userChangePassword, async (ctx, input) => {
  const userId = actorUserId(ctx);
  const user = await ctx.query.get('User', userId);
  if (user === undefined) throw new SurfaceError('NOT_FOUND', 'Your account no longer exists.');
  // A wrong current password counts as a failed sign-in of the account (AC-6, S6 review), so a
  // stolen session can't guess the password here once sign-in would lock. Reserved before the
  // check, on its own connection: the refusal rolls this transaction back, the attempt stays.
  // The input schema has already run, so a bad new password never counts as a guess.
  // The reservation takes a second pool connection while this transaction holds one: as many
  // checks at once as the pool has connections would wait on each other, unlikely at our size.
  const key = accountKey(user.email);
  const reservation = await ctx.attempts.reserve([key], ctx.now());
  if (!reservation.ok) {
    const minutes = Math.ceil(reservation.lockedForSeconds / 60);
    throw new SurfaceError(
      'RATE_LIMITED',
      `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfter: reservation.lockedForSeconds },
    );
  }
  // Locked, so two changes at once can't each pass the check against the old password.
  const [credentials] = await ctx.tx
    .select({ passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .for('update');
  if (
    credentials === undefined ||
    !(await verifyPassword(credentials.passwordHash, input.currentPassword))
  ) {
    throw new SurfaceError('INVALID_INPUT', WRONG_CURRENT_PASSWORD, {
      issues: [{ path: ['currentPassword'], message: WRONG_CURRENT_PASSWORD }],
    });
  }
  // Like a successful sign-in: forgets this attempt and the account's earlier failures.
  await ctx.attempts.succeeded(reservation.attempt, key);
  const passwordHash = await hashPassword(input.newPassword);
  await ctx.tx
    .update(userCredentials)
    .set({ passwordHash, updatedAt: ctx.now() })
    .where(eq(userCredentials.userId, userId));
  const sessionId = ctx.actor.sessionId;
  // E10. An actor without a session (an API key, M6) keeps none.
  const endedSessions = await ctx.closeSessions(
    userId,
    sessionId === undefined ? { all: true } : { except: sessionId },
  );
  // SPEC-001 §10: ids only, never a password.
  ctx.audit('auth.password_changed', { userId }, 'password changed');
  return { endedSessions };
});
