/** `AutoContext` over the operation's Postgres transaction (SPEC-015 §6.3). */
import { eq } from 'drizzle-orm';
import { teams, workflowStatuses } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import {
  identifierOf,
  lockIssueForWrite,
  writeAutoCloseHistory,
  writeLifecycleHistory,
} from '../../issues/lifecycle.js';
import type { AutoContext } from './auto-core.js';

export function autoContext(ctx: HandlerContext): AutoContext {
  const { tx } = ctx;
  return {
    access: {
      async shareTeam(teamId) {
        const [row] = await tx
          .select({
            autoArchiveMonths: teams.autoArchiveMonths,
            autoCloseMonths: teams.autoCloseMonths,
            autoCloseStatusId: teams.autoCloseStatusId,
          })
          .from(teams)
          .where(eq(teams.id, teamId))
          .for('share');
        return row;
      },
      async shareStatus(statusId) {
        const [row] = await tx
          .select({
            id: workflowStatuses.id,
            teamId: workflowStatuses.teamId,
            category: workflowStatuses.category,
          })
          .from(workflowStatuses)
          .where(eq(workflowStatuses.id, statusId))
          .for('key share');
        return row;
      },
      lockIssue: (issueId, mode) => lockIssueForWrite(tx, issueId, { actor: ctx.actor }, mode),
      async statusCategory(statusId) {
        const [row] = await tx
          .select({ category: workflowStatuses.category })
          .from(workflowStatuses)
          .where(eq(workflowStatuses.id, statusId));
        return row?.category;
      },
      identifier: (issue) => identifierOf(tx, issue),
    },
    repo: ctx.repo,
    now: ctx.now(),
    emit: (event) => ctx.emit(event),
    history: (kind, issue) => writeLifecycleHistory(ctx, kind, issue),
    closeHistory: (issue, changes) => writeAutoCloseHistory(ctx, issue, changes),
  };
}
