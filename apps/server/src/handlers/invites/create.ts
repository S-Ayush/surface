import { EMAIL_TAKEN_MESSAGE, INVITE_TTL_MS } from '@surface/domain';
import { inviteCreate } from '@surface/operations';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { invites, users, workspace } from '../../db/schema/index.js';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { actorUserId } from '../teams/shared.js';
import { inviteOutput } from './shared.js';

// SPEC-001 §3.4: an Admin invites someone by link. The executor checked `p.admin()` and resolved
// the teams with the Admin's visibility, so a private team they can't see is NOT_FOUND
// (permissions.md §5). The invite, its email job and the event share this transaction.
export default handler(inviteCreate, async (ctx, input) => {
  const inviterId = actorUserId(ctx, 'invite people');
  const teams = ctx.refs['teams'];
  const teamIds =
    teams === undefined ? [] : 'id' in teams ? [teams.id] : teams.map((team) => team.id);

  // E3: deactivated accounts count too: their email is still theirs (INV-02).
  if (input.email !== undefined) {
    const [taken] = await ctx.tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (taken) {
      throw new SurfaceError('CONFLICT', EMAIL_TAKEN_MESSAGE, {
        issues: [{ path: ['email'], message: EMAIL_TAKEN_MESSAGE }],
      });
    }
  }

  const now = ctx.now();
  // The newest invite for an email is the one that works (SPEC-001 §3.4; S9 security review I2,
  // the user's decision): re-inviting replaces an earlier invite, say one with the wrong role,
  // rather than leaving both links open. Like an Admin's revoke, it waits for a concurrent accept's
  // row lock, and accepted or expired invites keep their state.
  if (input.email !== undefined) {
    await ctx.tx
      .update(invites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invites.email, input.email),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now),
        ),
      );
  }

  const link = ctx.links.invite();
  const [row] = await ctx.tx
    .insert(invites)
    .values({
      id: uuidv7(),
      email: input.email ?? null,
      tokenHash: link.tokenHash,
      role: input.role,
      teamIds: [...new Set(teamIds)],
      invitedById: inviterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    })
    .returning();
  if (!row) throw new Error('The invite was not stored');

  // E7, D7: `emailed` means queued. Sending is retried later; the link is shown either way.
  let emailed = false;
  if (input.email !== undefined) {
    const [place] = await ctx.tx.select({ name: workspace.name }).from(workspace).limit(1);
    const inviter = await ctx.query.get('User', inviterId);
    emailed = await ctx.enqueueEmail({
      template: 'invite',
      to: input.email,
      workspaceName: place?.name ?? 'Surface',
      inviterName: inviter?.name ?? 'An Admin',
      link: link.url,
    });
  }

  ctx.emit({
    type: 'user.invited',
    subject: { type: 'invite', id: row.id },
    data: { role: row.role, teamIds: row.teamIds },
  });
  ctx.audit('user.invited', { actorId: inviterId }, 'invite created');
  // The teams were resolved with the actor's visibility, so the actor sees every one.
  return { invite: inviteOutput(row, now, new Set(row.teamIds)), url: link.url, emailed };
});
