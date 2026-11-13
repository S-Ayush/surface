/** `LifecycleAccess` and `LifecycleContext` over the operation's Postgres transaction. */
import type { HandlerContext } from '../../executor/context.js';
import {
  identifierOf,
  lockIssueForWrite,
  RESTORE_RELOG_LIMIT,
  RESTORE_RELOG_STEPS,
  writeLifecycleHistory,
} from '../../issues/lifecycle.js';
import type { LifecycleContext } from './lifecycle-core.js';

export function lifecycleContext(ctx: HandlerContext): LifecycleContext {
  const { tx } = ctx;
  return {
    access: {
      lockIssue: (issueId, mode) => lockIssueForWrite(tx, issueId, { actor: ctx.actor }, mode),
      identifier: (issue) => identifierOf(tx, issue),
      async relogRows(issueId) {
        const rows = [];
        for (const step of RESTORE_RELOG_STEPS) {
          rows.push({ model: step.model, ids: await step.ids(tx, issueId, RESTORE_RELOG_LIMIT) });
        }
        return rows;
      },
    },
    repo: ctx.repo,
    actor: ctx.actor,
    now: ctx.now(),
    emit: (event) => ctx.emit(event),
    history: () => writeLifecycleHistory(),
  };
}
