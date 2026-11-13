/**
 * The issue side of SPEC-010's label cascades (SPEC-011 §4.9). A cascade is a settings change,
 * not an issue edit: no history, no `issue.updated` event, no `updatedAt` change, and no lifecycle
 * rule, so archived and deleted issues are rewritten too and keep their state (E20).
 *
 * Lock order (§4.8): the caller (`label.delete`, PLAN-010 S5) has taken the team row (the
 * workspace row for a workspace label) and then the label row `FOR UPDATE`. Holding the label
 * means no edit can newly add it, so the set of issues read here is final; `updateWhere` then
 * locks those issues in ascending id.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { issues } from '../db/schema/index.js';
import type { Repo } from '../sync/repo.js';

/**
 * Removes `labelId` from `labelIds` of every issue that has it, whatever its lifecycle state, with
 * one logged `U` per issue under its stored groups. Returns the ids of the issues it rewrote, in
 * ascending order. Call it only while holding the label row `FOR UPDATE`.
 */
export async function removeLabelFromIssues(
  tx: NodePgDatabase,
  repo: Repo,
  labelId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(sql`${issues.labelIds} @> ARRAY[${labelId}]::uuid[]`)
    .orderBy(issues.id);
  if (rows.length === 0) return [];
  return repo.updateWhere(
    'Issue',
    rows.map((row) => row.id),
    // Computed per row under its lock, so a concurrent edit of other labels is never lost.
    { labelIds: sql`array_remove(${issues.labelIds}, ${labelId}::uuid)` },
    { touchUpdatedAt: false },
  );
}
