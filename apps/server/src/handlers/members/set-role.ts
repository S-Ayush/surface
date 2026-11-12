import { LAST_ADMIN_MESSAGE, leavesNoAdmin } from '@surface/domain';
import { forbiddenReason, userSetRole } from '@surface/operations';
import { and, eq } from 'drizzle-orm';
import { users } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { resolved } from '../teams/shared.js';
import { userOutput } from './shared.js';

// SPEC-001 §3.6: an Admin makes someone an Admin or a Member. The executor checked `p.admin()`
// on the role read when the request was signed in (auth/sessions.ts), before this transaction.
export default handler(userSetRole, async (ctx, input) => {
  const ref = resolved(ctx.refs['user'], 'user');

  // INV-01, E6, AC-10: lock every active Admin before counting them, in id order so concurrent
  // callers take the locks alike. Two Admins demoting each other at once then run one after the
  // other: the second waits for the first's commit, re-reads the locked rows (READ COMMITTED), no
  // longer finds the first among the Admins, and is refused. The `active` filter matters from M7
  // (deactivation); until the held integration test, it is checked by hand (PLAN-001 S7).
  const admins = await ctx.tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true)))
    .orderBy(users.id)
    .for('no key update');
  const adminIds = admins.map((admin) => admin.id);

  // An actor demoted while this request waited on the lock is no longer an Admin: without this, a
  // request already in flight could undo the demotion. The system actor has no user row.
  const actorId = ctx.actor.userId;
  if (actorId !== undefined && !adminIds.includes(actorId)) {
    throw new SurfaceError('FORBIDDEN', forbiddenReason(['Admins'], userSetRole.summary));
  }

  const user = await ctx.query.get('User', ref.id);
  if (!user) throw refNotFound('UserRef', input.user, ['user']);
  if (user.role === input.role) return userOutput(user);
  if (leavesNoAdmin(adminIds, user.id, input.role)) {
    throw new SurfaceError('CONFLICT', LAST_ADMIN_MESSAGE);
  }

  const updated = await ctx.repo.update('User', user.id, { role: input.role });
  ctx.emit({
    type: 'user.role_changed',
    subject: { type: 'user', id: user.id },
    changes: { role: { from: user.role, to: input.role } },
  });
  // SPEC-001 §10, written once this attempt commits (a retried or rolled-back one logs nothing).
  ctx.audit(
    'user.role_changed',
    {
      ...(actorId === undefined ? {} : { actorId }),
      userId: user.id,
      from: user.role,
      to: input.role,
    },
    'role changed',
  );
  return userOutput(updated);
});
