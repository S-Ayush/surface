// The issue list as data (SPEC-012 §3.3, §3.9): which issues a list holds, how they group, and
// what each row and group header shows. Pure functions over plain rows, so the team list, My issues
// and PLAN-015 S4's archive pages share one model. `useIssueRows` feeds it from the replica.
import {
  CLOSED_CATEGORIES,
  formatDueDate,
  formatEstimate,
  isPriority,
  isValidEstimate,
  issueIdentifier,
  namedStatusGroups,
  startsCollapsed,
  statusGroups,
  type ColorHue,
  type EstimateConfig,
  type GroupableIssue,
  type GroupableStatus,
  type IssueGroup,
  type Priority,
  type StatusCategory,
} from '@surface/domain';

/**
 * `active` reads the replica. `archived` and `deleted` take their rows from PLAN-015 S4's server
 * data source (the replica holds neither, SPEC-011 §5.7); the deleted one shows the deletion day.
 */
export type ListVariant = 'active' | 'archived' | 'deleted';

/** Whose issues the list holds. */
export type ListScope =
  | { readonly kind: 'team'; readonly teamId: string }
  | { readonly kind: 'assigned'; readonly userId: string }
  | { readonly kind: 'created'; readonly userId: string };

/** What the list reads of an issue. */
export interface ListIssue extends GroupableIssue {
  readonly teamId: string;
  readonly title: string;
  readonly assigneeId: string | null;
  readonly creatorId: string;
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
}

export interface ListStatus extends GroupableStatus {
  readonly color: ColorHue;
}

export interface ListTeam {
  readonly key: string;
  readonly estimate: EstimateConfig;
}

export interface ListLookups {
  readonly statuses: readonly ListStatus[];
  readonly teams: ReadonlyMap<string, ListTeam>;
  readonly labels: ReadonlyMap<string, { readonly name: string; readonly color: ColorHue }>;
  readonly users: ReadonlyMap<string, { readonly name: string; readonly avatarUrl?: string }>;
  /** `YYYY-MM-DD` in the viewer's zone: overdue, and the year of a short date. */
  readonly today: string;
}

export interface ListRow {
  readonly issueId: string;
  readonly teamId: string;
  /** `ENG-42`, or `ENG-…` while the number is pending. */
  readonly identifier: string;
  readonly pending: boolean;
  readonly title: string;
  readonly priority: Priority;
  readonly status: {
    readonly name: string;
    readonly category: StatusCategory;
    readonly color: ColorHue;
  };
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: ColorHue;
  }[];
  /** Undefined while the team doesn't use estimates (the column is hidden); null when empty. */
  readonly estimate: { readonly label: string; readonly offScale: boolean } | null | undefined;
  readonly dueDate: { readonly label: string; readonly overdue: boolean } | null;
  readonly assignee: { readonly name: string; readonly avatarUrl?: string } | null;
  /** The created day, or the deletion day on the deleted variant. */
  readonly createdLabel: string;
}

/** What the composer needs from a group's `+` (PLAN-012 S5): the status to start with. */
export interface AddTarget {
  /** The team list's team; null in My issues (the composer picks the context team). */
  readonly teamId: string | null;
  /** The group's status on a team list; My issues matches by name and category. */
  readonly statusId: string;
  readonly statusName: string;
  readonly assignToMe: boolean;
}

export interface ListGroup {
  /** The status id (team list) or `category:name` (My issues): the key of the collapse state. */
  readonly key: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: ColorHue;
  readonly add: AddTarget;
  readonly rows: readonly ListRow[];
}

/** One line of the flattened list: what `VirtualList` indexes. */
export type ListItem =
  | { readonly kind: 'header'; readonly id: string; readonly group: ListGroup }
  | { readonly kind: 'row'; readonly id: string; readonly row: ListRow };

/** The focus id of a group header (issue ids are uuids, so the two never collide). */
export const headerId = (groupKey: string) => `group:${groupKey}`;

/** The issues `scope` and `variant` select, before grouping. */
export function selectIssues<I extends ListIssue>(
  scope: ListScope,
  variant: ListVariant,
  issues: readonly I[],
  statuses: readonly GroupableStatus[],
): I[] {
  const category = new Map(statuses.map((status) => [status.id, status.category]));
  return issues.filter((issue) => {
    if (variant === 'active' && (issue.archivedAt !== null || issue.deletedAt !== null)) {
      return false;
    }
    if (variant === 'archived' && (issue.archivedAt === null || issue.deletedAt !== null)) {
      return false;
    }
    if (variant === 'deleted' && issue.deletedAt === null) return false;
    switch (scope.kind) {
      case 'team':
        return issue.teamId === scope.teamId;
      case 'assigned': {
        // Assigned holds open issues only (§3.9 item 2).
        const status = category.get(issue.statusId);
        return (
          issue.assigneeId === scope.userId &&
          status !== undefined &&
          !CLOSED_CATEGORIES.has(status)
        );
      }
      case 'created':
        return issue.creatorId === scope.userId;
    }
  });
}

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "Nov 6", with the year when it isn't this year (D2). `iso` is an instant; the day is local. */
export function formatCreated(iso: string, today: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const label = MONTH_DAY.format(date);
  return date.getFullYear() === Number(today.slice(0, 4))
    ? label
    : `${label}, ${String(date.getFullYear())}`;
}

function toRow(
  issue: ListIssue,
  variant: ListVariant,
  lookups: ListLookups,
  statusById: ReadonlyMap<string, ListStatus>,
): ListRow | undefined {
  const team = lookups.teams.get(issue.teamId);
  const status = statusById.get(issue.statusId);
  if (team === undefined || status === undefined) return undefined;
  const assignee = issue.assigneeId === null ? undefined : lookups.users.get(issue.assigneeId);
  const estimateOn = team.estimate.scale !== 'off';
  let estimate: ListRow['estimate'];
  if (issue.estimate === null) estimate = estimateOn ? null : undefined;
  else if (estimateOn) {
    estimate = {
      label: formatEstimate(team.estimate, issue.estimate),
      offScale: !isValidEstimate(team.estimate, issue.estimate),
    };
  } else {
    // A value left from an earlier scale stays visible, as its number (SPEC-010 E5).
    estimate = { label: String(issue.estimate), offScale: true };
  }
  return {
    issueId: issue.id,
    teamId: issue.teamId,
    identifier: issue.number === null ? `${team.key}-…` : issueIdentifier(team.key, issue.number),
    pending: issue.number === null,
    title: issue.title,
    priority: isPriority(issue.priority) ? issue.priority : 0,
    status: { name: status.name, category: status.category, color: status.color },
    labels: issue.labelIds
      .flatMap((id) => {
        const label = lookups.labels.get(id);
        return label === undefined ? [] : [{ id, ...label }];
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    estimate,
    dueDate:
      issue.dueDate === null
        ? null
        : {
            label: formatDueDate(issue.dueDate, lookups.today),
            overdue: issue.dueDate < lookups.today && !CLOSED_CATEGORIES.has(status.category),
          },
    assignee: assignee ?? null,
    createdLabel: formatCreated(
      variant === 'deleted' ? (issue.deletedAt ?? issue.createdAt) : issue.createdAt,
      lookups.today,
    ),
  };
}

/**
 * The list's groups: by status in workflow order on a team list, by status name and category in
 * My issues (statuses belong to teams). Empty groups are left out; rows are in the fixed order of
 * D17 (`issue-order.ts`).
 */
export function buildGroups(
  scope: ListScope,
  variant: ListVariant,
  issues: readonly ListIssue[],
  lookups: ListLookups,
): ListGroup[] {
  const statusById = new Map(lookups.statuses.map((status) => [status.id, status]));
  const selected = selectIssues(scope, variant, issues, lookups.statuses);
  const grouped: IssueGroup<ListIssue>[] =
    scope.kind === 'team'
      ? statusGroups(lookups.statuses, selected)
      : namedStatusGroups(lookups.statuses, selected);
  return grouped.flatMap((group): ListGroup[] => {
    const rows = group.issues.flatMap((issue) => toRow(issue, variant, lookups, statusById) ?? []);
    if (rows.length === 0) return [];
    const color = statusById.get(group.status.id)?.color ?? 'gray';
    return [
      {
        key: group.key,
        name: group.name,
        category: group.category,
        color,
        add: {
          teamId: scope.kind === 'team' ? scope.teamId : null,
          statusId: group.status.id,
          statusName: group.name,
          assignToMe: scope.kind === 'assigned',
        },
        rows,
      },
    ];
  });
}

/** Per-group collapse choices: a group the user never toggled follows its category (D16). */
export type CollapseState = Readonly<Record<string, boolean>>;

export function isCollapsed(state: CollapseState, group: ListGroup): boolean {
  return state[group.key] ?? startsCollapsed(group.category);
}

/** The groups as the lines the virtual list shows: a header, then its rows unless collapsed. */
export function flattenGroups(groups: readonly ListGroup[], state: CollapseState): ListItem[] {
  const items: ListItem[] = [];
  for (const group of groups) {
    items.push({ kind: 'header', id: headerId(group.key), group });
    if (isCollapsed(state, group)) continue;
    for (const row of group.rows) items.push({ kind: 'row', id: row.issueId, row });
  }
  return items;
}

/** Issue ids in list order, collapsed groups included: the source list the issue page steps through. */
export function orderedIssueIds(groups: readonly ListGroup[]): string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.issueId));
}
