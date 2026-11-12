/** `WorkflowAccess` over the operation's Postgres transaction, and the status output shape. */
import type { StatusSchema } from '@surface/operations';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { teams, workflowStatuses } from '../../db/schema/index.js';
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
        .select({ id: teams.id, key: teams.key, defaultStatusId: teams.defaultStatusId })
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
    // No issue table until PLAN-010 S5 (PLAN-011 S3 adds it): nothing uses a status yet.
    issueCounts: () => Promise.resolve({ live: 0, archived: 0, recentlyDeleted: 0 }),
  };
}
