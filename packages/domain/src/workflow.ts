/**
 * Workflow status rules for the settings operations (SPEC-010 §4.1, §6). Pure functions, shared by
 * the client's `optimistic` and the server's handlers, so both refuse the same things with the
 * same words. INV-04 and INV-05 themselves are `workflowProblems` in `workspace.ts`.
 */
import { nameProblem } from './names.js';
import type { StatusCategory } from './status-category.js';

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
