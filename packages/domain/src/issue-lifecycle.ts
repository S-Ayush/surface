/**
 * An issue's lifecycle state (SPEC-015 §4.1) and the refusal an edit gets outside Live (SPEC-011
 * §6.1, SPEC-015 §4.2). Shared by the server's `lockIssueForWrite` and the client. PLAN-011 S3
 * adds what the issue lock needs; PLAN-015 S1 adds `purgeAfter`, `canRestore` and the rest of
 * SPEC-015's messages here.
 */

/** Live, Archived or Deleted. A purged issue has no row, so no state. */
export const ISSUE_LIFECYCLES = ['live', 'archived', 'deleted'] as const;
export type IssueLifecycle = (typeof ISSUE_LIFECYCLES)[number];

export interface LifecycleFields {
  /** Any truthy value means set: an ISO string on the client, a `Date` on the server. */
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}

const isSet = (value: unknown): boolean => value !== null && value !== undefined;

/** Deleted whenever `deletedAt` is set, whatever `archivedAt` is (SPEC-015 §4.1). */
export function lifecycleOf(issue: LifecycleFields): IssueLifecycle {
  if (isSet(issue.deletedAt)) return 'deleted';
  return isSet(issue.archivedAt) ? 'archived' : 'live';
}

/**
 * Why a direct edit of an issue (or of its children) is refused in `state`, or undefined when it
 * is live (SPEC-015 §4.3). `identifier` is `ENG-42`. It holds even for an edit that changes
 * nothing (SPEC-011 E12).
 */
export function editRefusal(identifier: string, state: IssueLifecycle): string | undefined {
  switch (state) {
    case 'live':
      return undefined;
    case 'archived':
      return `${identifier} is archived. Restore it to edit it.`;
    case 'deleted':
      return `${identifier} was deleted. Restore it to edit it.`;
  }
}
