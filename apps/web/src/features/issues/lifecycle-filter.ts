// The lifecycle filter every issue list view applies (SPEC-015 §5.2, AC-9; PLAN-015 S4): the live
// lists show live issues only, the archive page's Issues tab archived ones, and its Recently deleted
// tab deleted ones until their `purgeAfter`. One rule from `packages/domain` (`inIssueView`), so an
// optimistic row, or a row the server sent a moment before it changed, never shows in the wrong
// view.
import { inIssueView, type IssueListView, type LifecycleFields } from '@surface/domain';

/** The list views: `active` (team issues, My issues), `archived` and `deleted` (the archive page). */
export type ListVariant = IssueListView;

/** Whether `issue` belongs in a list of `variant` at `now`. */
export function inListVariant(
  issue: LifecycleFields,
  variant: ListVariant,
  now: Date = new Date(),
): boolean {
  return inIssueView(issue, variant, now);
}

/** The issues of `issues` that belong in a list of `variant`, in their order. */
export function forListVariant<I extends LifecycleFields>(
  issues: readonly I[],
  variant: ListVariant,
  now: Date = new Date(),
): I[] {
  return issues.filter((issue) => inListVariant(issue, variant, now));
}
