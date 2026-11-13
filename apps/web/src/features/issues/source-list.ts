// The list an issue page was opened from (SPEC-012 §3.4 items 1 and 9, D14, E10, E11). The list
// puts its ordered issue ids in router state when it opens an issue (PLAN-012 S3, on `Enter` or a
// click); the page steps through them with `J`/`K` and the ↓ ↑ buttons. A page opened any other
// way (a pasted link, `Mod+K`) has no source list, and shows no position (L15).
//
// The ids are read again at each key press (E11): `readSourceList` is a plain function of the
// router state, so S3 can keep the state current while the list changes, and a stale snapshot
// still steps correctly because the current issue is looked up in it each time.

/** A source list: where the page goes back to, and the list's issue ids in its current order. */
export type SourceList = {
  /** The list's address (`/team/ENG`, `/my-issues`), where `Esc` goes back to. */
  readonly path: string;
  readonly ids: readonly string[];
};

/** The router-state key S3 writes the source list under. */
export const SOURCE_LIST_STATE_KEY = 'issueSourceList';

/** Router state for opening an issue from a list: `navigate({ to, state: sourceListState(…) })`. */
export function sourceListState(source: SourceList): Record<string, SourceList> {
  return { [SOURCE_LIST_STATE_KEY]: source };
}

/** The source list in router state, or undefined when the page wasn't opened from a list. */
export function readSourceList(state: unknown): SourceList | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const value: unknown = Reflect.get(state, SOURCE_LIST_STATE_KEY);
  if (typeof value !== 'object' || value === null) return undefined;
  const path: unknown = Reflect.get(value, 'path');
  const ids: unknown = Reflect.get(value, 'ids');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return undefined;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
    return undefined;
  }
  return { path, ids };
}

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

/** Where `Esc` goes: the source list, else the issue's team list (§3.4 item 9). */
export function backTarget(source: SourceList | undefined, teamKey: string): string {
  return source?.path ?? `/team/${encodeURIComponent(teamKey)}`;
}

type FocusRestorer = (issueId: string) => void;
let restoreListFocus: FocusRestorer = () => undefined;

/**
 * PLAN-012 S3's focus model registers here to put focus back on the issue's row after `Esc`
 * (SPEC-012 §3.3 item 8). Until it does, going back restores nothing. Returns an unregister.
 */
export function setListFocusRestorer(restorer: FocusRestorer): () => void {
  restoreListFocus = restorer;
  return () => {
    if (restoreListFocus === restorer) restoreListFocus = () => undefined;
  };
}

/** Called by the page after it navigated back to the list. */
export function restoreFocusOn(issueId: string): void {
  restoreListFocus(issueId);
}
