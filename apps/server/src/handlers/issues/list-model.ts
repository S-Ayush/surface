/**
 * The list model behind `issue.list`, `count` and `groupBy` (SPEC-011 §6.1). Visibility (sync
 * groups and an API key's teams) is applied in SQL first (`executor/list.ts`); deleted issues are
 * never listed, archived ones only with `includeArchived`. Manual order is `(sortOrder, id)` in
 * byte order (the column is `COLLATE "C"`). Every subquery into another synced table applies the
 * actor's groups, so neither a filter nor a group name reads a row the actor can't see.
 */
import { ISSUE_FILTER_FIELDS, PRIORITIES, RETENTION_HOURS } from '@surface/domain';
import { sql } from 'drizzle-orm';
import { issues } from '../../db/schema/index.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';

const groupsParam = (groups: readonly string[]) => sql`${sql.param([...groups])}::text[]`;

/** `WHEN 0 THEN 'No priority' …`: our constants, not input. */
const PRIORITY_WHENS = sql.raw(
  PRIORITIES.map((p) => `WHEN ${String(p.value)} THEN '${p.label}'`).join(' '),
);

const issueFilter = defineFilterModel({
  fields: ISSUE_FILTER_FIELDS,
  columns: (scope) => ({
    team: sql`${issues.teamId}`,
    number: sql`${issues.number}`,
    title: sql`${issues.title}`,
    status: sql`${issues.statusId}`,
    'status.category': sql`(SELECT s.category FROM workflow_statuses s
        WHERE s.id = ${issues.statusId} AND s.sync_groups && ${groupsParam(scope.groups)})`,
    priority: sql`${issues.priority}`,
    assignee: sql`${issues.assigneeId}`,
    creator: sql`${issues.creatorId}`,
    labels: sql`${issues.labelIds}`,
    estimate: sql`${issues.estimate}`,
    dueDate: sql`${issues.dueDate}`,
    createdAt: sql`${issues.createdAt}`,
    updatedAt: sql`${issues.updatedAt}`,
    startedAt: sql`${issues.startedAt}`,
    completedAt: sql`${issues.completedAt}`,
    canceledAt: sql`${issues.canceledAt}`,
    archivedAt: sql`${issues.archivedAt}`,
  }),
});

const issueFilterRefs = {
  team: 'TeamRef',
  status: 'StatusRef',
  assignee: 'UserRef',
  creator: 'UserRef',
  labels: 'LabelRef',
} as const;

export const issueListModel = defineListModel({
  table: issues,
  filter: issueFilter,
  filterRefs: issueFilterRefs,
  order: {
    sortOrder: 'text',
    number: 'number',
    priority: 'number',
    createdAt: 'instant',
    updatedAt: 'instant',
    completedAt: 'instant',
    archivedAt: 'instant',
    dueDate: 'day',
  },
  defaultOrder: { field: 'sortOrder', direction: 'asc' },
  teamColumn: 'teamId',
  archivedColumn: 'archivedAt',
  deletedColumn: 'deletedAt',
  groupings: (groups) => ({
    status: {
      key: sql`${issues.statusId}::text`,
      label: sql`(SELECT s.name FROM workflow_statuses s
        WHERE s.id = ${issues.statusId} AND s.sync_groups && ${groupsParam(groups)})`,
    },
    assignee: {
      key: sql`${issues.assigneeId}::text`,
      label: sql`(SELECT u.name FROM users u
        WHERE u.id = ${issues.assigneeId} AND u.sync_groups && ${groupsParam(groups)})`,
    },
    priority: {
      key: sql`${issues.priority}::text`,
      label: sql`CASE ${issues.priority} ${PRIORITY_WHENS} END`,
    },
    // An issue counts in each of its labels, and once under "No label" when it has none.
    label: {
      lateral: sql`unnest(CASE WHEN cardinality(${issues.labelIds}) = 0
        THEN ARRAY[NULL]::uuid[] ELSE ${issues.labelIds} END) AS issue_label(id)`,
      key: sql`issue_label.id::text`,
      label: sql`(SELECT l.name FROM labels l
        WHERE l.id = issue_label.id AND l.sync_groups && ${groupsParam(groups)})`,
    },
  }),
});

/**
 * The Recently deleted list, `issue.listDeleted` (SPEC-015 §3.3, §6.1): deleted issues only,
 * archived or not, and only while `now < purgeAfter` (`deleted_at + 720 h`), so an issue leaves
 * the list at its boundary even before the `trash-purge` job runs (D6). The condition is the
 * index-friendly form, as the job's (`deleted_at > now - 720 h`, `issues_deleted_at_idx`). Same
 * filters as `issue.list`; visibility and an API key's teams first, in SQL (§5.3).
 */
export const deletedIssueListModel = defineListModel({
  table: issues,
  filter: issueFilter,
  filterRefs: issueFilterRefs,
  order: {
    deletedAt: 'instant',
    number: 'number',
    priority: 'number',
    createdAt: 'instant',
    updatedAt: 'instant',
    archivedAt: 'instant',
  },
  defaultOrder: { field: 'deletedAt', direction: 'desc' },
  teamColumn: 'teamId',
  scope: (now) =>
    sql`(${issues.deletedAt} IS NOT NULL AND ${issues.deletedAt} > ${now.toISOString()}::timestamptz - make_interval(hours => ${RETENTION_HOURS}))`,
});
