/** `WorkflowAccess` over the operation's Postgres transaction, and the status output shape. */
import type { StatusIssueCounts } from '@surface/domain';
import type { StatusSchema } from '@surface/operations';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { issues, teams, workflowStatuses } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import type { WorkflowAccess, StatusRow } from './core.js';

type StatusOutput = z.input<typeof StatusSchema>;

export function statusOutput(row: StatusRow): StatusOutput {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    category: row.category,
    color: row.color,
    description: row.description,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function workflowAccess(ctx: HandlerContext): WorkflowAccess {
  const { tx } = ctx;
  return {
    async lockTeam(teamId) {
      const [row] = await tx
        .select({
          id: teams.id,
          key: teams.key,
          defaultStatusId: teams.defaultStatusId,
          // SPEC-015 E22, SPEC-010 AC-5: read under this lock, so a concurrent change of the
          // auto-close status (team.updateAutomations, which locks the team row) either finished
          // before this delete or waits for it.
          autoCloseStatusId: teams.autoCloseStatusId,
        })
        .from(teams)
        .where(eq(teams.id, teamId))
        .for('update');
      return row;
    },
    statuses: (teamId) =>
      tx.select().from(workflowStatuses).where(eq(workflowStatuses.teamId, teamId)),
    async lockStatus(statusId) {
      const [row] = await tx
        .select()
        .from(workflowStatuses)
        .where(eq(workflowStatuses.id, statusId))
        .for('update');
      return row;
    },
    async shareStatus(statusId) {
      const [row] = await tx
        .select()
        .from(workflowStatuses)
        .where(eq(workflowStatuses.id, statusId))
        .for('key share');
      return row;
    },
    issueCounts: (statusId) => statusIssueCounts(tx, statusId),
  };
}

/**
 * The issues with `status_id = statusId`, by lifecycle state (SPEC-010 §4.4, AC-6). Every row
 * counts: a permanently deleted issue has none. Not filtered by the actor's groups: the delete
 * must refuse while any issue uses the status (the `RESTRICT` key would otherwise trip), and the
 * actor can already see the whole team (§5), so the answer depends on no invisible issue. A
 * deleted issue that was archived before counts as recently deleted (SPEC-015 D12). Takes no lock.
 */
export async function statusIssueCounts(
  tx: HandlerContext['tx'],
  statusId: string,
): Promise<StatusIssueCounts> {
  const [row] = await tx
    .select({
      live: sql<number>`count(*) filter (where ${issues.archivedAt} is null and ${issues.deletedAt} is null)::int`,
      archived: sql<number>`count(*) filter (where ${issues.archivedAt} is not null and ${issues.deletedAt} is null)::int`,
      recentlyDeleted: sql<number>`count(*) filter (where ${issues.deletedAt} is not null)::int`,
    })
    .from(issues)
    .where(eq(issues.statusId, statusId));
  return row ?? { live: 0, archived: 0, recentlyDeleted: 0 };
}
