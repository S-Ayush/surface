// Optimistic-store helpers shared by the issue content operations (comments and reactions,
// SPEC-013 §6.1; PLAN-013 S3, S4): reading a row's string field and finding a live issue.
import { lifecycleOf } from '@surface/domain';
import type { OptimisticStore, StoreRow } from '../optimistic.js';

/** The row's `field` when it is a string, else undefined. */
export function text(row: StoreRow | undefined, field: string): string | undefined {
  const value = row?.[field];
  return typeof value === 'string' ? value : undefined;
}

/** The issue, when the store holds it and it is live (archived and deleted are CONFLICT, D10). */
export function liveIssue(store: OptimisticStore, ref: string | undefined): StoreRow | undefined {
  if (ref === undefined) return undefined;
  const issue = store.get('Issue', ref);
  if (issue === undefined) return undefined;
  const state = lifecycleOf({ archivedAt: issue['archivedAt'], deletedAt: issue['deletedAt'] });
  return state === 'live' ? issue : undefined;
}
