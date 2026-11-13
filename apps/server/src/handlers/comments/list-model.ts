/**
 * The list model behind `comment.list` (SPEC-013 §6.1). Visibility (sync groups and an API key's
 * teams, by `team_id`) is applied in SQL first (`executor/list.ts`). The list is one issue's: the
 * handler adds `issue = <id>` to the filter. Soft-deleted comments (placeholders) are listed, with
 * no body, so their replies keep their thread.
 */
import { COMMENT_FILTER_FIELDS, defineFilterFields } from '@surface/domain';
import { sql } from 'drizzle-orm';
import { comments } from '../../db/schema/index.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';

export const commentListModel = defineListModel({
  table: comments,
  filter: defineFilterModel({
    // `issue` scopes the list to the input's issue; the documented filters are the domain's.
    fields: defineFilterFields({ ...COMMENT_FILTER_FIELDS, issue: { type: 'ref' } }),
    columns: () => ({
      issue: sql`${comments.issueId}`,
      author: sql`${comments.userId}`,
      createdAt: sql`${comments.createdAt}`,
      editedAt: sql`${comments.editedAt}`,
      resolvedAt: sql`${comments.resolvedAt}`,
    }),
  }),
  filterRefs: { author: 'UserRef' },
  order: { createdAt: 'instant' },
  // Oldest first, the timeline's order (§7).
  defaultOrder: { field: 'createdAt', direction: 'asc' },
  teamColumn: 'teamId',
});
