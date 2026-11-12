/** Output shape of the invite handlers and routes (PLAN-001 S5). */
import { inviteStatus } from '@surface/domain';
import type { InviteSchema } from '@surface/operations';
import { and, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { teams, type invites } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { visibleTo } from '../../executor/list.js';

type InviteOutput = z.input<typeof InviteSchema>;

export type InviteRow = typeof invites.$inferSelect;

/**
 * The teams among `teamIds` the actor can see. An invite into a private team the actor isn't in
 * must not show that team's id (permissions.md §5; Admins don't see private teams until M7).
 */
export async function visibleTeamIds(
  ctx: Pick<HandlerContext, 'tx' | 'actor'>,
  teamIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (teamIds.length === 0) return new Set();
  const rows = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(inArray(teams.id, [...teamIds]), visibleTo(ctx.actor, teams.syncGroups, teams.id)));
  return new Set(rows.map((row) => row.id));
}

/** The invite as an operation answers it: only the teams in `visible` (see `visibleTeamIds`). */
export function inviteOutput(
  row: InviteRow,
  now: Date,
  visible: ReadonlySet<string>,
): InviteOutput {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    teamIds: row.teamIds.filter((id) => visible.has(id)),
    invitedById: row.invitedById,
    status: inviteStatus(row, now),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
