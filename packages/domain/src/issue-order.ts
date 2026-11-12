/**
 * Order and grouping of issues in lists (SPEC-012 §3.3, §3.9, D17). Pure, so the list model and a
 * later display-options feature share it.
 */
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';

export interface OrderableIssue {
  /** 0 = no priority, 1 = Urgent … 4 = Low. */
  readonly priority: number;
  /** ISO 8601, with any offset. */
  readonly updatedAt: string;
  /** Null only while the create is pending. */
  readonly number: number | null;
}

/** Urgent first, No priority last. */
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

function instant(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Priority (Urgent first, none last), then `updatedAt` newest first, then number highest first. A
 * pending issue (no number) sorts above numbered ones. Lists add the issue id as a last key
 * (`statusGroups`), so equal keys never swap.
 */
export function compareIssuesInGroup(a: OrderableIssue, b: OrderableIssue): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  const byTime = instant(b.updatedAt) - instant(a.updatedAt);
  if (byTime !== 0) return byTime;
  const an = a.number ?? Number.POSITIVE_INFINITY;
  const bn = b.number ?? Number.POSITIVE_INFINITY;
  if (an === bn) return 0;
  return bn > an ? 1 : -1;
}

export interface GroupableStatus {
  readonly id: string;
  readonly name: string;
  readonly category: StatusCategory;
  /** A fractional key, compared in byte order (SPEC-010 §4.2). */
  readonly position: string;
}

export interface GroupableIssue extends OrderableIssue {
  readonly id: string;
  readonly statusId: string;
}

export interface IssueGroup<I extends GroupableIssue> {
  /** Stable key for collapse state and React: the status id, or `category:name` for named groups. */
  readonly key: string;
  readonly name: string;
  readonly category: StatusCategory;
  /** The status whose icon and colour the header shows (the lowest position in the group). */
  readonly status: GroupableStatus;
  readonly issues: readonly I[];
}

/** Completed and Canceled groups start collapsed (SPEC-012 D16). */
export function startsCollapsed(category: StatusCategory): boolean {
  return category === 'completed' || category === 'canceled';
}

function categoryRank(category: StatusCategory): number {
  return STATUS_CATEGORIES.indexOf(category);
}

/** Byte order, like the database's `COLLATE "C"`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIssues(a: GroupableIssue, b: GroupableIssue): number {
  return compareIssuesInGroup(a, b) || compareText(a.id, b.id);
}

function compareStatuses(a: GroupableStatus, b: GroupableStatus): number {
  return (
    categoryRank(a.category) - categoryRank(b.category) ||
    compareText(a.position, b.position) ||
    compareText(a.id, b.id)
  );
}

/**
 * The team list: one group per status, in workflow order (category order, then position). Empty
 * groups are left out, and so are issues on a status that isn't in `statuses`.
 */
export function statusGroups<I extends GroupableIssue>(
  statuses: readonly GroupableStatus[],
  issues: readonly I[],
): IssueGroup<I>[] {
  const byStatus = new Map<string, I[]>();
  for (const issue of issues) {
    const list = byStatus.get(issue.statusId);
    if (list) list.push(issue);
    else byStatus.set(issue.statusId, [issue]);
  }
  const groups: IssueGroup<I>[] = [];
  for (const status of [...statuses].sort(compareStatuses)) {
    const list = byStatus.get(status.id);
    if (!list || list.length === 0) continue;
    groups.push({
      key: status.id,
      name: status.name,
      category: status.category,
      status,
      issues: list.sort(compareIssues),
    });
  }
  return groups;
}

/**
 * My issues: statuses belong to teams, so issues whose status has the same name and category share
 * a group. Groups follow category order, then the lowest status position among the group's
 * statuses, then name. Empty groups are left out.
 */
export function namedStatusGroups<I extends GroupableIssue>(
  statuses: readonly GroupableStatus[],
  issues: readonly I[],
): IssueGroup<I>[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const groups = new Map<string, { status: GroupableStatus; issues: I[] }>();
  for (const issue of issues) {
    const status = statusById.get(issue.statusId);
    if (!status) continue;
    const key = `${status.category}:${status.name}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { status, issues: [issue] });
      continue;
    }
    group.issues.push(issue);
    if (compareStatuses(status, group.status) < 0) group.status = status;
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      name: group.status.name,
      category: group.status.category,
      status: group.status,
      issues: group.issues.sort(compareIssues),
    }))
    .sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        compareText(a.status.position, b.status.position) ||
        compareText(a.name, b.name),
    );
}
