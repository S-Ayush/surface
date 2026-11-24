/**
 * The client evaluator of an Issue filter (SPEC-011 §6.1, AC-11; SPEC-003 §7.4): which replica
 * Issue rows a filter of `issue.list` matches. It reads `ISSUE_FILTER_FIELDS`, the definition the
 * server's SQL compiler reads too (`apps/server/src/handlers/issues/list-model.ts`), so the two
 * can't drift apart by a field; `apps/server/test/issue-filter-conformance.int.test.ts` checks
 * they give the same answer.
 *
 * Reference filters (`team`, `status`, `assignee`, `creator`, `labels`) hold ids here: the server
 * resolves names before it compiles, and a client filter is built from rows it holds.
 */
import type { FieldGetter, Filter, FilterContext } from './filter/index.js';
import { matches, resolveFilter } from './filter/index.js';
import { ISSUE_FILTER_FIELDS } from './issue.js';

export type IssueFilterField = keyof typeof ISSUE_FILTER_FIELDS;

/** The Issue fields a filter reads, as a replica row holds them (the `Issue` model). */
export interface IssueFilterRow {
  readonly teamId: unknown;
  readonly number: unknown;
  readonly title: unknown;
  readonly statusId: unknown;
  readonly priority: unknown;
  readonly assigneeId: unknown;
  readonly creatorId: unknown;
  readonly labelIds: unknown;
  readonly estimate: unknown;
  readonly dueDate: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly startedAt: unknown;
  readonly canceledAt: unknown;
  readonly completedAt: unknown;
  readonly archivedAt: unknown;
}

/**
 * The category of a status the replica holds, or undefined. A status the replica lacks (another
 * team's, or one it can't see) has no category, as the SQL compiler's visibility-filtered join.
 */
export type StatusCategoryOf = (statusId: string) => string | undefined;

/** Each filter field's value on a row: the one place a field meets a column on the client. */
const VALUES: {
  readonly [F in IssueFilterField]: (row: IssueFilterRow, categoryOf: StatusCategoryOf) => unknown;
} = {
  team: (row) => row.teamId,
  number: (row) => row.number,
  title: (row) => row.title,
  status: (row) => row.statusId,
  'status.category': (row, categoryOf) =>
    typeof row.statusId === 'string' ? (categoryOf(row.statusId) ?? null) : null,
  priority: (row) => row.priority,
  assignee: (row) => row.assigneeId,
  creator: (row) => row.creatorId,
  labels: (row) => row.labelIds,
  estimate: (row) => row.estimate,
  dueDate: (row) => row.dueDate,
  createdAt: (row) => row.createdAt,
  updatedAt: (row) => row.updatedAt,
  startedAt: (row) => row.startedAt,
  completedAt: (row) => row.completedAt,
  canceledAt: (row) => row.canceledAt,
  archivedAt: (row) => row.archivedAt,
};

function isIssueFilterField(field: string): field is IssueFilterField {
  return Object.hasOwn(VALUES, field);
}

/** The getter `matches` reads an Issue row with. */
export function issueFieldGetter(categoryOf: StatusCategoryOf): FieldGetter<IssueFilterRow> {
  return (row, field) => (isIssueFilterField(field) ? VALUES[field](row, categoryOf) : undefined);
}

/**
 * The rows of `rows` that `filter` matches, in their order. Throws `FilterError` for a filter the
 * server would refuse (an unknown field, an operator its type lacks, a malformed value).
 *
 * No list scope is applied: the server's issue list adds "not archived, not deleted" to the
 * compiled filter itself, but the replica holds live issues only (SPEC-011 §5.7, AC-29), so its
 * rows are already in scope. A caller passing archived or deleted rows gets them filtered like any
 * other.
 */
export function filterIssues<Row extends IssueFilterRow>(
  rows: readonly Row[],
  filter: Filter,
  ctx: FilterContext,
  categoryOf: StatusCategoryOf,
): Row[] {
  const resolved = resolveFilter(filter, ISSUE_FILTER_FIELDS, ctx);
  const get = issueFieldGetter(categoryOf);
  return rows.filter((row) => matches(resolved, row, get));
}
