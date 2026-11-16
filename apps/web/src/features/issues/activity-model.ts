// The issue page's activity stream as plain data (SPEC-012 §3.4 item 4, D18; SPEC-013 §7;
// PLAN-012 S4b): history entries and comment threads in one list, oldest first, of which the
// newest 30 show until "Show N earlier". Pure, so the order and the cut are tested without a DOM.
import { IssueHistory, type ModelRow, type RowOfModel } from '@surface/domain/model';
import type { Thread } from '../comments/model.js';

/** SPEC-012 D18: how many of the newest items show at first. */
export const ACTIVITY_SHOWN = 30;

export type HistoryRow = RowOfModel<typeof IssueHistory>;

export type ActivityItem =
  | {
      readonly kind: 'history';
      readonly id: string;
      readonly at: string;
      readonly entry: HistoryRow;
    }
  | { readonly kind: 'thread'; readonly id: string; readonly at: string; readonly thread: Thread };

/** The content rows that are history entries; a row that doesn't match the model is left out. */
export function historyRows(rows: readonly ModelRow[] | undefined): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const row of rows ?? []) {
    const parsed = IssueHistory.rowSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * History entries and threads by time, oldest first (SPEC-013 §7: "interleaved by time"). An entry
 * is placed at its `createdAt` (a fold moves only `updatedAt`), a thread at its first comment's.
 * Ties keep history before comments, then id order, so the order is total.
 */
export function activityItems(
  history: readonly HistoryRow[],
  threads: readonly Thread[],
): ActivityItem[] {
  const items: ActivityItem[] = [
    ...history.map((entry): ActivityItem => ({
      kind: 'history',
      id: entry.id,
      at: entry.createdAt,
      entry,
    })),
    ...threads.map((thread): ActivityItem => ({
      kind: 'thread',
      id: thread.root.id,
      at: thread.root.createdAt,
      thread,
    })),
  ];
  return items.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      (a.kind === b.kind ? 0 : a.kind === 'history' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** What shows: everything when expanded, else the newest `ACTIVITY_SHOWN`, and how many are hidden. */
export function visibleActivity(
  items: readonly ActivityItem[],
  expanded: boolean,
): { readonly earlier: number; readonly shown: readonly ActivityItem[] } {
  if (expanded || items.length <= ACTIVITY_SHOWN) return { earlier: 0, shown: items };
  const earlier = items.length - ACTIVITY_SHOWN;
  return { earlier, shown: items.slice(earlier) };
}

/** "Show 12 earlier" (SPEC-012 §3.4 item 4). */
export const showEarlierLabel = (earlier: number): string => `Show ${earlier} earlier`;
