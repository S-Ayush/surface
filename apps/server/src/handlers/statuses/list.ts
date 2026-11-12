import {
  COLOR_HUES,
  STATUS_CATEGORIES,
  defineFilterFields,
  isStatusCategory,
  type Filter,
} from '@surface/domain';
import { statusList } from '@surface/operations';
import { sql } from 'drizzle-orm';
import { workflowStatuses } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';
import { teamRef } from '../teams/shared.js';
import { statusOutput } from './access.js';
import { pageStatuses } from './page.js';

/**
 * `status.list`: the statuses the actor can see. Statuses are never archived, so there is no
 * archived column. `teamId` is filterable so the handler can scope the list to its team.
 */
export const statusListModel = defineListModel({
  table: workflowStatuses,
  filter: defineFilterModel({
    fields: defineFilterFields({
      teamId: { type: 'ref' },
      category: { type: 'enum', values: STATUS_CATEGORIES },
      name: { type: 'text' },
      color: { type: 'enum', values: COLOR_HUES },
      createdAt: { type: 'instant' },
    }),
    columns: () => ({
      teamId: sql`${workflowStatuses.teamId}`,
      category: sql`${workflowStatuses.category}`,
      name: sql`${workflowStatuses.name}`,
      color: sql`${workflowStatuses.color}`,
      createdAt: sql`${workflowStatuses.createdAt}`,
    }),
  }),
  order: { name: 'text', position: 'text', createdAt: 'instant' },
  defaultOrder: { field: 'position', direction: 'asc' },
  teamColumn: 'teamId',
});

/** A team has at most 50 statuses (STATUS_LIMIT), so one page of the maximum holds them all. */
const ALL = 100;

export default handler(statusList, async (ctx, input) => {
  const team = teamRef(ctx.refs['team']);
  const conditions: Filter[] = [{ field: 'teamId', op: 'eq', value: team.id }];
  if (input.category !== undefined) {
    conditions.push({ field: 'category', op: 'eq', value: input.category });
  }
  if (input.filter !== undefined) conditions.push(input.filter);
  const filter: Filter = { and: conditions };

  if (input.orderBy !== undefined) {
    const page = await ctx.query.list(statusListModel, { ...input, filter });
    return { ...page, nodes: page.nodes.map(statusOutput) };
  }

  // Default order (SPEC-010 §6): category order, then position (`page.ts`). A keyset page orders
  // by one column, so the whole team's statuses (at most 50) are read and cut after the cursor.
  const all = await ctx.query.list(statusListModel, { filter, limit: ALL });
  const known = all.nodes.filter((s) => isStatusCategory(s.category));
  const { nodes, hasNextPage, endCursor } = pageStatuses(known, input.limit, input.cursor);
  return { nodes: nodes.map(statusOutput), pageInfo: { hasNextPage, endCursor } };
});
