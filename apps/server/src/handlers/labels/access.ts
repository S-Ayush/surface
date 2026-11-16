/** `LabelAccess` over the operation's Postgres transaction, and the label output shape. */
import type { LabelSchema } from '@surface/operations';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { issues, labels, teams, workspace } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { visibleTo } from '../../executor/list.js';
import { removeLabelFromIssues } from '../../issues/cascade.js';
import type { LabelAccess, LabelRow } from './core.js';

type LabelOutput = z.input<typeof LabelSchema>;

export function labelOutput(row: LabelRow): LabelOutput {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    color: row.color,
    description: row.description,
    parentId: row.parentId,
    isGroup: row.isGroup,
    exclusive: row.exclusive,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function labelAccess(ctx: HandlerContext): LabelAccess {
  const { tx } = ctx;
  return {
    async lockWorkspace() {
      await tx.select({ id: workspace.id }).from(workspace).for('update');
    },
    async lockTeam(teamId) {
      const [row] = await tx
        .select({ id: teams.id, key: teams.key })
        .from(teams)
        .where(eq(teams.id, teamId))
        .for('update');
      return row;
    },
    scopeLabels: (teamId) =>
      tx
        .select()
        .from(labels)
        .where(teamId === null ? isNull(labels.teamId) : eq(labels.teamId, teamId)),
    async lockLabel(labelId) {
      const [row] = await tx.select().from(labels).where(eq(labels.id, labelId)).for('update');
      return row;
    },
    async shareLabel(labelId) {
      const [row] = await tx.select().from(labels).where(eq(labels.id, labelId)).for('key share');
      return row;
    },
    removeFromIssues: (labelId) => removeLabelFromIssues(tx, ctx.repo, labelId),
    async visibleIssueCount(issueIds) {
      // One array parameter, however many issues (the bind limit is 65,535).
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            sql`${issues.id} = ANY(${sql.param([...issueIds])}::uuid[])`,
            visibleTo(ctx.actor, issues.syncGroups, issues.teamId),
          ),
        );
      return row?.count ?? 0;
    },
  };
}
