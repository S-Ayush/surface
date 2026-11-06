import { defineFilterFields } from '@surface/domain';
import { debugListItems } from '@surface/operations';
import { sql } from 'drizzle-orm';
import { debugItems } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';

export const debugItemList = defineListModel({
  table: debugItems,
  filter: defineFilterModel({
    fields: defineFilterFields({
      title: { type: 'text' },
      counter: { type: 'number' },
      updatedAt: { type: 'instant' },
    }),
    columns: () => ({
      title: sql`${debugItems.title}`,
      counter: sql`${debugItems.counter}`,
      updatedAt: sql`${debugItems.updatedAt}`,
    }),
  }),
  order: { title: 'text', counter: 'number', updatedAt: 'instant' },
  defaultOrder: { field: 'updatedAt', direction: 'desc' },
  teamColumn: null,
});

export default handler(debugListItems, async (ctx, input) => {
  const page = await ctx.query.list(debugItemList, input);
  return {
    ...page,
    nodes: page.nodes.map((item) => ({
      id: item.id,
      title: item.title,
      counter: item.counter,
      updatedAt: item.updatedAt.toISOString(),
    })),
  };
});
