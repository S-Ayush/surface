import { inviteList } from '@surface/operations';
import { invites } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { invitePage } from './list-model.js';
import { inviteOutput, visibleTeamIds } from './shared.js';

// SPEC-001 §3.4: Admins see who was invited. Invites are server-only and few, so they are read
// whole and paged in memory (list-model.ts). Status is computed against this execution's clock.
// Each invite shows only the teams the actor can see (permissions.md §5).
export default handler(inviteList, async (ctx, input) => {
  const now = ctx.now();
  const rows = await ctx.tx.select().from(invites);
  const visible = await visibleTeamIds(ctx, [...new Set(rows.flatMap((row) => row.teamIds))]);
  return invitePage(
    rows.map((row) => inviteOutput(row, now, visible)),
    input,
    { now, me: ctx.actor.userId ?? null },
  );
});
