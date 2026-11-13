import { COLOR_HUES, defineFilterFields, type Filter } from '@surface/domain';
import { labelList } from '@surface/operations';
import { sql } from 'drizzle-orm';
import { labels } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';
import { resolved } from '../teams/shared.js';
import { labelOutput } from './access.js';

/**
 * `label.list`: the labels the actor can see. `teamColumn` is null because a key narrowed to some
 * teams still reads workspace labels (SPEC-010 §5): the handler adds that narrowing as a filter.
 * Name order is the database collation's; the settings page sorts the replica's rows itself.
 */
export const labelListModel = defineListModel({
  table: labels,
  filter: defineFilterModel({
    fields: defineFilterFields({
      teamId: { type: 'ref' },
      parentId: { type: 'ref' },
      name: { type: 'text' },
      color: { type: 'enum', values: COLOR_HUES },
      isGroup: { type: 'boolean' },
      exclusive: { type: 'boolean' },
      createdAt: { type: 'instant' },
    }),
    columns: () => ({
      teamId: sql`${labels.teamId}`,
      parentId: sql`${labels.parentId}`,
      name: sql`${labels.name}`,
      color: sql`${labels.color}`,
      isGroup: sql`${labels.isGroup}`,
      exclusive: sql`${labels.exclusive}`,
      createdAt: sql`${labels.createdAt}`,
    }),
  }),
  order: { name: 'text', createdAt: 'instant' },
  defaultOrder: { field: 'name', direction: 'asc' },
  teamColumn: null,
  archivedColumn: 'archivedAt',
});

const WORKSPACE: Filter = { field: 'teamId', op: 'exists', value: false };

export default handler(labelList, async (ctx, input) => {
  const team = input.team === undefined ? undefined : resolved(ctx.refs['team'], 'team');
  const conditions: Filter[] = [];

  const inTeam: Filter | undefined =
    team === undefined ? undefined : { field: 'teamId', op: 'eq', value: team.id };
  if (input.scope === 'workspace') conditions.push(WORKSPACE);
  else if (input.scope === 'team') {
    conditions.push(inTeam ?? { field: 'teamId', op: 'exists', value: true });
  } else if (inTeam !== undefined) conditions.push({ or: [inTeam, WORKSPACE] });

  // A key narrowed to some teams sees those teams' labels and the workspace's (permissions §3.5).
  const keyTeams = ctx.actor.apiKey?.teamIds ?? [];
  if (keyTeams.length > 0) {
    conditions.push({ or: [WORKSPACE, { field: 'teamId', op: 'in', value: [...keyTeams] }] });
  }
  if (input.group !== undefined) {
    conditions.push({
      field: 'parentId',
      op: 'eq',
      value: resolved(ctx.refs['group'], 'group').id,
    });
  }
  if (input.filter !== undefined) conditions.push(input.filter);

  const filter: Filter | undefined = conditions.length === 0 ? undefined : { and: conditions };
  const page = await ctx.query.list(labelListModel, {
    ...input,
    ...(filter === undefined ? {} : { filter }),
  });
  return { ...page, nodes: page.nodes.map(labelOutput) };
});
