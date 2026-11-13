// Stepping through the list an issue page was opened from (SPEC-012 §3.4 items 1 and 9, D14, E10,
// E11). The list itself (`IssueListSource`, its router-state key and `readListSource`) is
// `focus-model.ts`'s, from PLAN-012 S3; this file is the page's part: where an issue stands in
// the ids and where `J`/`K` go. The ids are the list's current ones, read again at each key press
// (E11). A page opened any other way (a pasted link, `Mod+K`) has no list, so no position (L15).

export type Direction = 'next' | 'previous';

export type StepInfo = {
  /** 1-based, for "3 / 41". */
  readonly position: number;
  readonly total: number;
  /** Undefined at the ends (E10): the button is disabled and the key does nothing. */
  readonly previous: string | undefined;
  readonly next: string | undefined;
};

/**
 * Where `issueId` stands in `ids` right now. Undefined when the source list is missing or no longer
 * holds the issue (it was removed from the list while open): the position is hidden then.
 */
export function stepInfo(
  ids: readonly string[] | undefined,
  issueId: string,
): StepInfo | undefined {
  if (ids === undefined) return undefined;
  const index = ids.indexOf(issueId);
  if (index === -1) return undefined;
  return {
    position: index + 1,
    total: ids.length,
    previous: ids[index - 1],
    next: ids[index + 1],
  };
}

/** The issue `J` (next) or `K` (previous) opens; undefined at the ends or without a source. */
export function stepTarget(
  ids: readonly string[] | undefined,
  issueId: string,
  direction: Direction,
): string | undefined {
  const info = stepInfo(ids, issueId);
  return direction === 'next' ? info?.next : info?.previous;
}

/** Where `Esc` goes when the page wasn't opened from a list: the issue's team list (§3.4 item 9). */
export function teamListPath(teamKey: string): string {
  return `/team/${encodeURIComponent(teamKey)}`;
}
