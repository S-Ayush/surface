// The issue list as data (SPEC-012 §3.3, §3.9): which issues a list holds, how they group, and
// what each row and group header shows. Pure functions over plain rows, so the team list, My issues
// and PLAN-015 S4's archive pages share one model. `useIssueRows` feeds it from the replica.
import {
  CLOSED_CATEGORIES,
  COLOR_HUES,
  formatDueDate,
  formatEstimate,
  isPriority,
  isValidEstimate,
  issueIdentifier,
  labelsOf,
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
import { forListVariant, type ListVariant } from './lifecycle-filter.js';

/**
 * `active` reads the replica. `archived` and `deleted` take their rows from PLAN-015 S4's server
 * data source (`features/archive/archive-source.ts`; the replica holds neither, SPEC-011 §5.7);
 * they show the archive day and the deletion day.
 */
export type { ListVariant };

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
  /** The created day; the archive day on the archived variant, the deletion day on the deleted. */
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
  // Every list view filters by lifecycle (SPEC-015 §5.2), so no view forgets.
  return forListVariant(issues, variant).filter((issue) => {
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

/** The day a row shows (SPEC-015 §3.3): the archive day, the deletion day, else the created day. */
function dateShown(
  issue: Pick<ListIssue, 'createdAt' | 'archivedAt' | 'deletedAt'>,
  variant: ListVariant,
): string {
  if (variant === 'deleted') return issue.deletedAt ?? issue.createdAt;
  if (variant === 'archived') return issue.archivedAt ?? issue.createdAt;
  return issue.createdAt;
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
    // A label deleted while its deltas are on the way is skipped (SPEC-010 §5).
    labels: labelsOf(issue, (id) => {
      const label = lookups.labels.get(id);
      return label === undefined ? undefined : { id, ...label };
    }),
    estimate,
    dueDate:
      issue.dueDate === null
        ? null
        : {
            label: formatDueDate(issue.dueDate, lookups.today),
            overdue: issue.dueDate < lookups.today && !CLOSED_CATEGORIES.has(status.category),
          },
    assignee: assignee ?? null,
    createdLabel: formatCreated(dateShown(issue, variant), lookups.today),
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
export function flattenGroups(
  groups: readonly ListGroup[],
  state: CollapseState,
  /** False for a flat list (the archive page): rows only, none collapsed. */
  headers = true,
): ListItem[] {
  const items: ListItem[] = [];
  for (const group of groups) {
    if (!headers) {
      for (const row of group.rows) items.push({ kind: 'row', id: row.issueId, row });
      continue;
    }
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

// ---- The archive page (SPEC-015 §3.3; PLAN-015 S4) ----

/** An issue as `issue.list` and `issue.listDeleted` answer it: what an archive row reads. */
export interface ArchivedIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly status: {
    readonly id: string;
    readonly name: string;
    readonly category: StatusCategory;
  };
  readonly priority: number;
  readonly assignee: { readonly id: string; readonly name: string } | null;
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

const isHue = (value: string): value is ColorHue => COLOR_HUES.some((hue) => hue === value);

function archiveEstimate(team: ListTeam | undefined, estimate: number | null): ListRow['estimate'] {
  const estimateOn = team !== undefined && team.estimate.scale !== 'off';
  if (estimate === null) return estimateOn ? null : undefined;
  if (team === undefined || !estimateOn) return { label: String(estimate), offScale: true };
  return {
    label: formatEstimate(team.estimate, estimate),
    offScale: !isValidEstimate(team.estimate, estimate),
  };
}

/**
 * The archive page's rows (SPEC-015 §3.3): one flat group in the server's order (newest archived
 * or deleted first), normal issue rows whose date column shows the archive or deletion day. Rows
 * come from the server; status colours, estimate scales and avatars come from the replica when it
 * holds them. A row that doesn't belong in `variant` (it changed since it was read) is left out.
 */
export function archiveGroups(
  variant: Exclude<ListVariant, 'active'>,
  teamId: string,
  issues: readonly ArchivedIssue[],
  lookups: ListLookups,
  now: Date = new Date(),
): ListGroup[] {
  const team = lookups.teams.get(teamId);
  const statusById = new Map(lookups.statuses.map((status) => [status.id, status]));
  const rows = forListVariant(issues, variant, now).map((issue): ListRow => {
    const user = issue.assignee === null ? undefined : lookups.users.get(issue.assignee.id);
    return {
      issueId: issue.id,
      teamId,
      identifier: issue.identifier,
      pending: false,
      title: issue.title,
      priority: isPriority(issue.priority) ? issue.priority : 0,
      status: {
        name: issue.status.name,
        category: issue.status.category,
        color: statusById.get(issue.status.id)?.color ?? 'gray',
      },
      labels: issue.labels.map((label) => ({
        id: label.id,
        name: label.name,
        color: isHue(label.color) ? label.color : 'gray',
      })),
      estimate: archiveEstimate(team, issue.estimate),
      // Out of the live lists, nothing is overdue any more.
      dueDate:
        issue.dueDate === null
          ? null
          : { label: formatDueDate(issue.dueDate, lookups.today), overdue: false },
      assignee: issue.assignee === null ? null : (user ?? { name: issue.assignee.name }),
      createdLabel: formatCreated(dateShown(issue, variant), lookups.today),
    };
  });
  if (rows.length === 0) return [];
  return [
    {
      key: variant,
      name: variant === 'archived' ? 'Archived issues' : 'Recently deleted issues',
      category: 'completed',
      color: 'gray',
      add: { teamId, statusId: '', statusName: '', assignToMe: false },
      rows,
    },
  ];
}
