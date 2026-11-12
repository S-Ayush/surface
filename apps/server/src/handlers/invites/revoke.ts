import { inviteRevoke } from '@surface/operations';
import { eq } from 'drizzle-orm';
import { invites } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { resolved } from '../teams/shared.js';
import { inviteOutput, visibleTeamIds } from './shared.js';

// SPEC-001 §3.4 step 5: an Admin turns off a pending invite. The row is locked first, so a revoke
// and an accept at the same moment run one after the other: the accept route's
// `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL` then finds it revoked, or this
// finds it accepted.
export default handler(inviteRevoke, async (ctx) => {
  const ref = resolved(ctx.refs['invite'], 'invite');
  const now = ctx.now();
  const [row] = await ctx.tx.select().from(invites).where(eq(invites.id, ref.id)).for('update');
  // Deleted between resolution and here: invites are never deleted, but stay honest.
  if (!row) throw new SurfaceError('NOT_FOUND', 'This invite no longer exists. Reload the list.');
  if (row.acceptedAt !== null) {
    throw new SurfaceError(
      'CONFLICT',
      'This invite was already accepted. Change the person’s role in Members instead.',
    );
  }
  // Revoked or expired already: its link doesn't work, so there is nothing to change.
  if (row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
    return inviteOutput(row, now, await visibleTeamIds(ctx, row.teamIds));
  }
  const [revoked] = await ctx.tx
    .update(invites)
    .set({ revokedAt: now })
    .where(eq(invites.id, row.id))
    .returning();
  if (!revoked) throw new Error('The invite was not revoked');
  return inviteOutput(revoked, now, await visibleTeamIds(ctx, revoked.teamIds));
});
