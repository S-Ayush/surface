// Which issues' content the app prefetches after start (SPEC-011 §5.4, PLAN-011 S7): the open
// issues assigned to the user, the most recently updated first. The store fetches only those of
// subscribed teams not hydrated yet; the list and the issue page prefetch what they show.
import { CLOSED_CATEGORIES, type StatusCategory } from '@surface/domain';

export interface AssignedCandidate {
  readonly id: string;
  readonly statusId: string;
  readonly assigneeId: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly updatedAt: string;
}

/** The ids of the open issues assigned to `userId`, most recently updated first, at most `limit`. */
export function assignedPrefetchIds(
  issues: readonly AssignedCandidate[],
  categories: ReadonlyMap<string, StatusCategory>,
  userId: string,
  limit: number,
): string[] {
  // Open, as the Assigned tab of My issues counts it (SPEC-012 §3.9 item 2).
  const open = (issue: AssignedCandidate) => {
    const category = categories.get(issue.statusId);
    return category !== undefined && !CLOSED_CATEGORIES.has(category);
  };
  return issues
    .filter(
      (issue) =>
        issue.assigneeId === userId &&
        issue.archivedAt === null &&
        issue.deletedAt === null &&
        open(issue),
    )
    .sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1,
    )
    .slice(0, limit)
    .map((issue) => issue.id);
}
