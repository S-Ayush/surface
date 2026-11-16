/**
 * The issue side of SPEC-010's label cascades (SPEC-011 §4.9). A cascade is a settings change,
 * not an issue edit: no history, no `issue.updated` event, no `updatedAt` change, and no lifecycle
 * rule, so archived and deleted issues are rewritten too and keep their state (E20).
 *
 * Lock order (§4.8): the caller (`label.delete`, PLAN-010 S5) has taken the team row (the
 * workspace row for a workspace label) and then the label row `FOR UPDATE`. Holding the label
 * means no edit can newly add it. An edit can still remove it meanwhile, so the issues are read
 * `FOR UPDATE` in ascending id: Postgres checks the condition again on a row it waited for, so an
 * issue that lost the label in the meantime is skipped, and gets no empty `U` and no count.
 * `updateWhere` then rewrites exactly those issues, whose locks this transaction already holds.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { issues } from '../db/schema/index.js';
import type { Repo } from '../sync/repo.js';

/**
 * Removes `labelId` from `labelIds` of every issue that still has it once locked, whatever its
 * lifecycle state, with one logged `U` per issue under its stored groups. Returns the ids of the
 * issues it rewrote, in ascending order. Call it only while holding the label row `FOR UPDATE`.
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
    .orderBy(issues.id)
    .for('update');
  if (rows.length === 0) return [];
  return repo.updateWhere(
    'Issue',
    rows.map((row) => row.id),
    // Computed per row under its lock, so a concurrent edit of other labels is never lost.
    { labelIds: sql`array_remove(${issues.labelIds}, ${labelId}::uuid)` },
    { touchUpdatedAt: false },
  );
}
