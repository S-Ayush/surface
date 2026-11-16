// The workflow page's model (SPEC-010 §3.1), pure: statuses grouped by category in page order,
// Triage hidden while triage is off (M4), Duplicate marked as the system status, who may edit,
// the form's own checks, and where an Alt+↑/↓ or a drop puts a status. Rules shared with the
// server (names, keys) come from `@surface/domain`, so the page and the server agree.
import {
  EDITABLE_STATUS_CATEGORIES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_TITLES,
  STATUS_DESCRIPTION_MAX_LENGTH,
  bindPredicates,
  countStatusIssues,
  placeStatus,
  sortStatuses,
  statusDeleteProblem,
  statusLimitProblem,
  statusNameProblem,
  type Actor,
  type ColorHue,
  type ResolvedRefs,
  type StatusCategory,
  type StatusIssueLike,
} from '@surface/domain';
import { statusCreate, statusDelete, statusReorder, statusUpdate } from '@surface/operations';

export type StatusItem = {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: ColorHue;
  readonly description: string | null;
  readonly position: string;
};

export type EditableCategory = (typeof EDITABLE_STATUS_CATEGORIES)[number];

/** Whether "Make default" is offered: Backlog or Unstarted only (INV-05), and not already it. */
export function canMakeDefault(
  status: { readonly category: StatusCategory; readonly id: string },
  isDefault: boolean,
): boolean {
  return !isDefault && (status.category === 'backlog' || status.category === 'unstarted');
}

export function isEditableCategory(category: StatusCategory): category is EditableCategory {
  return (EDITABLE_STATUS_CATEGORIES as readonly StatusCategory[]).includes(category);
}

export type CategoryGroup = {
  readonly category: StatusCategory;
  readonly title: string;
  readonly statuses: readonly StatusItem[];
  /** "+" is offered: not Triage, not Duplicate (§3.1). */
  readonly canAdd: boolean;
};

/**
 * The page's groups in category order (Backlog … Duplicate). Triage is listed only when triage
 * is on, which is M4, so `showTriage` is false until then. Empty categories stay: they have a "+".
 */
export function workflowGroups(
  statuses: readonly StatusItem[],
  { showTriage = false }: { readonly showTriage?: boolean } = {},
): CategoryGroup[] {
  const sorted = sortStatuses(statuses);
  return STATUS_CATEGORIES.filter((category) => showTriage || category !== 'triage').map(
    (category) => ({
      category,
      title: STATUS_CATEGORY_TITLES[category],
      statuses: sorted.filter((s) => s.category === category),
      canAdd: isEditableCategory(category),
    }),
  );
}

/** Duplicate is system-managed: no menu, no rename, no recolor, no delete (§3.1). */
export function isSystemStatus(status: Pick<StatusItem, 'category'>): boolean {
  return status.category === 'duplicate';
}

export type WorkflowAccess = {
  /** Add, edit, reorder and delete (the operations' own permission: members of the team, Admins). */
  readonly edit: boolean;
};

/**
 * Runs the status operations' permission predicates on the actor, as the command menu's pre-check
 * does, so the page and the server agree on who may act. The server still decides.
 */
export function workflowAccess(actor: Actor | null, team: { readonly id: string }): WorkflowAccess {
  if (actor === null) return { edit: false };
  const { p } = bindPredicates(actor);
  const refs: ResolvedRefs = { team };
  const allows = (permission: (refs: ResolvedRefs) => boolean) => {
    try {
      return permission(refs);
    } catch {
      // A predicate that needs the input is the server's to decide.
      return true;
    }
  };
  const input = { team: team.id };
  return {
    edit:
      allows((r) => statusCreate.permission(p, r, { ...input, name: 'x', category: 'started' })) &&
      allows((r) => statusUpdate.permission(p, r, { ...input, status: 'x' })) &&
      allows((r) => statusReorder.permission(p, r, { ...input, status: 'x', before: 'y' })) &&
      allows((r) => statusDelete.permission(p, r, { ...input, status: 'x' })),
  };
}

export type StatusFormValues = {
  readonly name: string;
  readonly color: ColorHue;
  readonly description: string;
};

export type StatusFormProblems = Partial<Record<'name' | 'description', string>>;

/**
 * The form's own checks, the same words as the server's. `others` are the team's other statuses
 * (a name clash is checked case-insensitively, as the server does); `count` is how many statuses
 * the team has now, for the 50-status limit when adding.
 */
export function statusFormProblems(
  values: StatusFormValues,
  others: readonly Pick<StatusItem, 'name'>[],
  { adding, count }: { readonly adding: boolean; readonly count: number },
): StatusFormProblems {
  const problems: { -readonly [K in keyof StatusFormProblems]?: string } = {};
  const name = values.name.trim();
  const nameProblem = statusNameProblem(name);
  if (nameProblem !== undefined) {
    problems.name = name === '' ? 'Status name is required, like In Review' : nameProblem;
  } else if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    problems.name = `A status named "${name}" already exists. Choose another name.`;
  } else if (adding) {
    const limit = statusLimitProblem(count);
    if (limit !== undefined) problems.name = limit;
  }
  if (values.description.trim().length > STATUS_DESCRIPTION_MAX_LENGTH) {
    problems.description = `Description must be at most ${STATUS_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return problems;
}

/**
 * Where `Alt+↑` or `Alt+↓` puts the status: one position, never out of its category. Undefined at
 * either end (nothing to do).
 */
export function moveOne(
  statuses: readonly StatusItem[],
  statusId: string,
  direction: 'up' | 'down',
): { readonly before: string } | { readonly after: string } | undefined {
  const status = statuses.find((s) => s.id === statusId);
  if (status === undefined || isSystemStatus(status) || status.category === 'triage') {
    return undefined;
  }
  const inCategory = sortStatuses(statuses.filter((s) => s.category === status.category));
  const at = inCategory.findIndex((s) => s.id === statusId);
  if (direction === 'up') {
    const previous = inCategory[at - 1];
    return previous === undefined ? undefined : { before: previous.id };
  }
  const next = inCategory[at + 1];
  return next === undefined ? undefined : { after: next.id };
}

/**
 * Where a drop puts the status: right before the row it was dropped on when it came from below
 * it, right after when it came from above, as Linear's drag does. Undefined for a drop on itself,
 * on another category, or one that changes nothing.
 */
export function dropTarget(
  statuses: readonly StatusItem[],
  statusId: string,
  overId: string,
): { readonly before: string } | { readonly after: string } | undefined {
  const status = statuses.find((s) => s.id === statusId);
  const over = statuses.find((s) => s.id === overId);
  if (status === undefined || over === undefined || status.id === over.id) return undefined;
  if (status.category !== over.category || isSystemStatus(status)) return undefined;
  const inCategory = sortStatuses(statuses.filter((s) => s.category === status.category));
  const from = inCategory.findIndex((s) => s.id === statusId);
  const to = inCategory.findIndex((s) => s.id === overId);
  const anchor = from < to ? { after: overId } : { before: overId };
  const placed = placeStatus(statuses, status.category, anchor, statusId);
  return placed.ok && !placed.unchanged ? anchor : undefined;
}

/** The text after the status name: "·" and the description, when there is one. */
export function descriptionText(status: Pick<StatusItem, 'description'>): string | undefined {
  const text = status.description?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/**
 * Why the replica already shows that deleting `statusId` will be refused for its issues, or
 * undefined (SPEC-010 §3.1 item 6, E8): the page toasts it and opens no dialog, as the
 * operation's prediction would refuse it anyway. The replica holds only some issues (SPEC-011
 * §5.7), so undefined means "ask the server", not "empty". Other refusals (default, last of a
 * category) are the server's, after the dialog.
 *
 * The replica's count is a lower bound, so once `issue.groupBy` has answered (`serverCount`:
 * live and archived issues the actor can see) the toast says the larger of the two. Only the
 * replica tells archived and recently deleted apart, so the suffix counts what it holds.
 */
export function replicaDeleteRefusal(
  statuses: readonly StatusItem[],
  statusId: string,
  defaultStatusId: string,
  issues: readonly StatusIssueLike[],
  serverCount?: number,
): string | undefined {
  if (!statuses.some((s) => s.id === statusId)) return undefined;
  const replica = countStatusIssues(issues, statusId);
  const total = replica.live + replica.archived + replica.recentlyDeleted;
  if (total === 0) return undefined;
  const larger = Math.max(total, serverCount ?? 0);
  const counts = { ...replica, live: larger - replica.archived - replica.recentlyDeleted };
  const problem = statusDeleteProblem({ statuses, statusId }, defaultStatusId, counts);
  return problem?.reason === 'hasIssues' ? problem.message : undefined;
}

/**
 * The per-status counts from `issue.groupBy` by status (SPEC-010 §5, D15): live and archived
 * issues the actor can see, never deleted ones. A status with no issue is not a group, so it is 0.
 */
export function countsByStatus(
  groups: readonly { readonly key: string | null; readonly count: number }[],
): ReadonlyMap<string, number> {
  return new Map(groups.flatMap((g) => (g.key === null ? [] : [[g.key, g.count] as const])));
}

/** One row's count: undefined ("—") until the server answers and offline, else 0 or more. */
export function statusIssueCount(
  counts: ReadonlyMap<string, number> | undefined,
  id: string,
): number | undefined {
  return counts === undefined ? undefined : (counts.get(id) ?? 0);
}
