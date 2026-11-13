// Focus for the issue lists (SPEC-012 §3.3 items 4 and 8, E1, E2, AC-5). Pure, so the rules are
// unit tested without a DOM. A focus id is an issue id or a group header's id (`headerId`).
//
// PLAN-012 S4 reads from here: `focusMemory` (what the list restores on `Esc`), `IssueListSource`
// (what the list puts in router state on `Enter`) and `readListSource` (what the page reads back).

/**
 * Where focus goes when the list changes under it. The same id keeps focus, wherever it moved to
 * (E1). An id that left takes its neighbour at the same index (the next row, the previous one at
 * the end; E2). Null only when the list is empty or nothing was focused.
 */
export function resolveFocus(
  previous: readonly string[],
  next: readonly string[],
  focusedId: string | null,
): string | null {
  if (focusedId === null || next.length === 0) return null;
  if (next.includes(focusedId)) return focusedId;
  const index = previous.indexOf(focusedId);
  if (index < 0) return next[0] ?? null;
  return next[Math.min(index, next.length - 1)] ?? null;
}

/** What a route's list remembers: the focused id, where it sat, and the scroll position. */
export interface RememberedFocus {
  readonly focusedId: string;
  readonly order: readonly string[];
  readonly scrollTop: number;
}

/** In-memory focus and scroll per route and tab (§3.3 item 8). Cleared on a reload, on purpose. */
export class FocusMemory {
  readonly #entries = new Map<string, RememberedFocus>();

  remember(routeKey: string, entry: RememberedFocus): void {
    this.#entries.set(routeKey, entry);
  }

  /** The remembered entry for the route, or undefined on a first visit. */
  recall(routeKey: string): RememberedFocus | undefined {
    return this.#entries.get(routeKey);
  }

  /** Where focus goes on a revisit, given the list as it is now (the neighbour if it left). */
  restore(routeKey: string, order: readonly string[]): string | null {
    const entry = this.#entries.get(routeKey);
    if (entry === undefined) return null;
    return resolveFocus(entry.order, order, entry.focusedId);
  }

  forget(routeKey: string): void {
    this.#entries.delete(routeKey);
  }

  clear(): void {
    this.#entries.clear();
  }
}

export const focusMemory = new FocusMemory();

/** The memory key of a list: the route, plus the tab on My issues. */
export const teamListKey = (teamKey: string) => `team:${teamKey.toUpperCase()}`;
export const myIssuesKey = (tab: 'assigned' | 'created') => `my-issues:${tab}`;

/**
 * The list an issue was opened from, put in router state on `Enter` or a click (§3.4 item 1): the
 * address to go back to, the focus-memory key, and the issue ids in list order (collapsed groups
 * included). The page reads the ids again at each key press (E11) and steps through them.
 */
export interface IssueListSource {
  readonly href: string;
  readonly routeKey: string;
  readonly issueIds: readonly string[];
}

/** The router-state key that holds an `IssueListSource`. */
export const LIST_SOURCE_STATE_KEY = 'issueListSource';

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The source list in a router state object, or undefined (a pasted link, `Mod+K`). */
export function readListSource(state: unknown): IssueListSource | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const value: unknown = Reflect.get(state, LIST_SOURCE_STATE_KEY);
  if (typeof value !== 'object' || value === null) return undefined;
  const href: unknown = Reflect.get(value, 'href');
  const routeKey: unknown = Reflect.get(value, 'routeKey');
  const issueIds: unknown = Reflect.get(value, 'issueIds');
  if (typeof href !== 'string' || typeof routeKey !== 'string' || !isStringArray(issueIds)) {
    return undefined;
  }
  return { href, routeKey, issueIds };
}
