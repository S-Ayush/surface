/**
 * `issue.list`, `issue.count` and `issue.groupBy` (SPEC-011 §6.1) over `issueListModel`. With
 * `team`, only that team's issues, and status and label names in the filter resolve within it.
 */
import type { Filter, RefEntity } from '@surface/domain';
import { issueCount, issueGroupBy, issueList, ISSUE_GROUP_LIMIT } from '@surface/operations';
import { handler, type HandlerContext } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';
import { issueOutputs } from './access.js';
import { issueListModel } from './list-model.js';

interface Scoped {
  readonly filter?: Filter | undefined;
  readonly scopeTeam?: RefEntity | undefined;
}

/** The input's filter narrowed to `team`, and the team names resolve within. */
function scoped(
  ctx: HandlerContext,
  input: { team?: string | undefined; filter?: Filter | undefined },
): Scoped {
  if (input.team === undefined) return { filter: input.filter };
  const team = resolved(ctx.refs['team'], 'team');
  const inTeam: Filter = { field: 'team', op: 'eq', value: team.id };
  return {
    filter: input.filter === undefined ? inTeam : { and: [inTeam, input.filter] },
    scopeTeam: team,
  };
}

export const listHandler = handler(issueList, async (ctx, input) => {
  const page = await ctx.query.list(issueListModel, {
    ...input,
    ...scoped(ctx, input),
    withTotal: input.withTotal ?? false,
  });
  // Summaries are the full output minus the fields only `IssueOutput` has; the executor's output
  // schema strips those, so one builder serves both.
  return { ...page, nodes: await issueOutputs(ctx, page.nodes) };
});

export const countHandler = handler(issueCount, async (ctx, input) => ({
  count: await ctx.query.count(issueListModel, { ...input, ...scoped(ctx, input) }),
}));

/** What a group with no key is called (§6.1). */
const NONE_NAMES: Readonly<Record<string, string>> = {
  assignee: 'No assignee',
  label: 'No label',
};

export const groupByHandler = handler(issueGroupBy, async (ctx, input) => {
  const groups = await ctx.query.groupBy(issueListModel, {
    ...input,
    ...scoped(ctx, input),
    groupBy: input.by,
    limit: ISSUE_GROUP_LIMIT,
  });
  return {
    groups: groups.map((g) => ({
      key: g.key,
      name: g.key === null ? (NONE_NAMES[input.by] ?? g.label) : g.label,
      count: g.count,
    })),
  };
});
