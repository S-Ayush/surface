/**
 * Workflow status rules for the settings operations (SPEC-010 §4.1, §6). Pure functions, shared by
 * the client's `optimistic` and the server's handlers, so both refuse the same things with the
 * same words. INV-04 and INV-05 themselves are `workflowProblems` in `workspace.ts`.
 */
import { fractionalKeyBetween } from './fractional-key.js';
import { nameProblem } from './names.js';
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';
import type { ColorHue } from './workspace.js';

/** At most 50 statuses per team (SPEC-010 D22). */
export const STATUS_LIMIT = 50;
export const STATUS_NAME_MAX_LENGTH = 50;
export const STATUS_DESCRIPTION_MAX_LENGTH = 255;

/** How a category is named in messages (state-machines §1). */
export const STATUS_CATEGORY_TITLES: Readonly<Record<StatusCategory, string>> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  canceled: 'Canceled',
  duplicate: 'Duplicate',
};

/** System categories: one status each, never created or deleted (INV-04, SPEC-010 §4.1). */
const SYSTEM_CATEGORIES: readonly StatusCategory[] = ['triage', 'duplicate'];

/** Why `name` can't be a status name, or undefined if it can (1–50 characters, trimmed). */
export function statusNameProblem(name: string): string | undefined {
  return nameProblem('Status name', name, STATUS_NAME_MAX_LENGTH);
}

/** Why a team that has `count` statuses can't get another, or undefined if it can (AC-13). */
export function statusLimitProblem(count: number): string | undefined {
  return count >= STATUS_LIMIT
    ? `A team can have at most ${STATUS_LIMIT} statuses. Delete one first.`
    : undefined;
}

export interface WorkflowStatusLike {
  readonly id: string;
  readonly name: string;
  readonly category: StatusCategory;
}

/**
 * The issues that use a status, by lifecycle state. Permanently deleted issues have no row, so
 * they are never counted (AC-6).
 */
export interface StatusIssueCounts {
  readonly live: number;
  readonly archived: number;
  /** In Recently deleted (the 30-day trash, SPEC-015). */
  readonly recentlyDeleted: number;
}

export type StatusDeleteRefusal =
  'system' | 'default' | 'autoClose' | 'lastInCategory' | 'hasIssues';

export interface StatusDeleteProblem {
  readonly reason: StatusDeleteRefusal;
  /** The message for `CONFLICT` (SPEC-010 §6). */
  readonly message: string;
}

function issueCountText(n: number): string {
  return n === 1 ? '1 issue' : `${n} issues`;
}

/**
 * Why the status `workflow.statusId` can't be deleted, or undefined if it can (SPEC-010 §4.1,
 * AC-5). Refuses in this order: Triage and Duplicate, the team's default status, the team's
 * auto-close status (SPEC-015 §4.9; optional until its column exists), the last status of its
 * category, and a status any issue uses (live, archived or recently deleted). `workflow.statuses`
 * are all the team's statuses, the one being deleted included.
 */
export function statusDeleteProblem(
  workflow: { readonly statuses: readonly WorkflowStatusLike[]; readonly statusId: string },
  defaultStatusId: string,
  issueCounts: StatusIssueCounts,
  autoCloseStatusId?: string | null,
): StatusDeleteProblem | undefined {
  const status = workflow.statuses.find((s) => s.id === workflow.statusId);
  if (!status) throw new Error(`Status ${workflow.statusId} is not in the workflow`);
  const title = STATUS_CATEGORY_TITLES[status.category];
  if (SYSTEM_CATEGORIES.includes(status.category)) {
    return { reason: 'system', message: `${title} is a system status and can't be deleted.` };
  }
  if (status.id === defaultStatusId) {
    return {
      reason: 'default',
      message: "Can't delete the default status. Make another status the default first.",
    };
  }
  if (autoCloseStatusId != null && status.id === autoCloseStatusId) {
    return {
      reason: 'autoClose',
      message:
        'This status closes stale issues. Choose another one in Settings → Automations first.',
    };
  }
  if (workflow.statuses.filter((s) => s.category === status.category).length <= 1) {
    return {
      reason: 'lastInCategory',
      message: `Every team needs at least one ${title} status. Add another before deleting this one.`,
    };
  }
  const hidden = issueCounts.archived + issueCounts.recentlyDeleted;
  const total = issueCounts.live + hidden;
  if (total > 0) {
    const suffix = hidden > 0 ? ` (${hidden} archived or recently deleted)` : '';
    return {
      reason: 'hasIssues',
      message: `Can't delete the "${status.name}" status. It has ${issueCountText(total)}${suffix}. Move ${total === 1 ? 'it' : 'them'} to another status first.`,
    };
  }
  return undefined;
}

/** An issue as the status-delete count reads it: a stored row (live, archived or deleted). */
export interface StatusIssueLike {
  readonly statusId: string;
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}

/**
 * The issues of `issues` on `statusId`, by lifecycle state (AC-6): a deleted issue counts as
 * recently deleted whether or not it was archived first. The server counts the same way in SQL;
 * the client's `status.delete` prediction counts the issues its replica holds.
 */
export function countStatusIssues(
  issues: readonly StatusIssueLike[],
  statusId: string,
): StatusIssueCounts {
  let live = 0;
  let archived = 0;
  let recentlyDeleted = 0;
  for (const issue of issues) {
    if (issue.statusId !== statusId) continue;
    if (issue.deletedAt != null) recentlyDeleted++;
    else if (issue.archivedAt != null) archived++;
    else live++;
  }
  return { live, archived, recentlyDeleted };
}

// ---------------------------------------------------------------------------------------------
// Create, reorder and the shape of a status row (SPEC-010 §4.1, §6). Shared by the handlers and
// the operations' `optimistic`, so the client predicts the key the server commits.

/** Categories a status can be created in (§4.1: never Triage or Duplicate). */
export const EDITABLE_STATUS_CATEGORIES = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const satisfies readonly StatusCategory[];

/** The hue a new status gets when none is given, as seeded by SPEC-001 (§4.1). */
export const STATUS_CATEGORY_COLORS: Readonly<Record<StatusCategory, ColorHue>> = {
  triage: 'orange',
  backlog: 'gray',
  unstarted: 'gray',
  started: 'yellow',
  completed: 'blue',
  canceled: 'gray',
  duplicate: 'gray',
};

/** Category order on the workflow page and in `status.list` (Triage first when it is on). */
export function statusCategoryRank(category: StatusCategory): number {
  return STATUS_CATEGORIES.indexOf(category);
}

/** Byte order of `position`, never `localeCompare` (the column is `COLLATE "C"`). */
export function comparePositions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PositionedStatus {
  readonly id: string;
  readonly category: StatusCategory;
  readonly position: string;
}

/** A team's statuses in display order: category, then position, then id. */
export function sortStatuses<T extends PositionedStatus>(statuses: readonly T[]): T[] {
  return [...statuses].sort(
    (a, b) =>
      statusCategoryRank(a.category) - statusCategoryRank(b.category) ||
      comparePositions(a.position, b.position) ||
      comparePositions(a.id, b.id),
  );
}

export type StatusPlacement =
  | { readonly ok: true; readonly position: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly field: 'before' | 'after'; readonly message: string };

/**
 * Where a status goes in `category`: right after `after`, right before `before`, or at the end.
 * `movingId` is a status being moved: it is left out of the neighbours, and `unchanged` says it
 * would stay where it is (a reorder then writes nothing). An anchor must be another status of the
 * same category (SPEC-010 §6, AC-3, E4).
 */
export function placeStatus(
  statuses: readonly PositionedStatus[],
  category: StatusCategory,
  anchor: { readonly before?: string | undefined; readonly after?: string | undefined },
  movingId?: string,
): StatusPlacement {
  const inCategory = sortStatuses(statuses.filter((s) => s.category === category));
  const others = inCategory.filter((s) => s.id !== movingId);
  const anchorId = anchor.after ?? anchor.before;
  const field = anchor.after !== undefined ? 'after' : 'before';
  let index = others.length;
  if (anchorId !== undefined) {
    if (anchorId === movingId) {
      return { ok: false, field, message: "Can't move a status next to itself." };
    }
    const at = others.findIndex((s) => s.id === anchorId);
    if (at < 0) {
      return {
        ok: false,
        field,
        message: `The ${field} status must be in the ${STATUS_CATEGORY_TITLES[category]} category. Choose a status in the same category.`,
      };
    }
    index = field === 'after' ? at + 1 : at;
  }
  const previous = others[index - 1];
  const next = others[index];
  const current = inCategory.findIndex((s) => s.id === movingId);
  // The status keeps its slot when the same number of others sit before it as before.
  const unchanged = movingId !== undefined && current >= 0 && index === current;
  return {
    ok: true,
    position: fractionalKeyBetween(previous?.position ?? null, next?.position ?? null),
    unchanged,
  };
}
