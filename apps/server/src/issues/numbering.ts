/**
 * Issue numbers and the new issue's order key (SPEC-011 §4.5), taken in the creating transaction.
 *
 * The counter row's lock orders concurrent creates in one team: numbers are gap-free in commit
 * order (a rolled-back create rolls its increment back too, D1), and the lowest sort key is read
 * **after** the lock, so two creates in one team never compute a key from the same neighbour.
 * Creates in two teams can read equal "lowest" keys; the random jitter makes their keys differ.
 */
import { randomInt } from 'node:crypto';
import { jitterFrom, keyBefore } from '@surface/domain';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { issues, teamIssueCounters } from '../db/schema/index.js';

/**
 * The team's next issue number. One upsert, `team_issue_counters`'s documented form: a team
 * without a counter row gets one, and the row stays locked until the transaction ends (INV-08:
 * the counter never goes down, so a committed number is never reused).
 */
export async function nextIssueNumber(tx: NodePgDatabase, teamId: string): Promise<number> {
  const [counter] = await tx
    .insert(teamIssueCounters)
    .values({ teamId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: teamIssueCounters.teamId,
      set: { lastNumber: sql`${teamIssueCounters.lastNumber} + 1` },
    })
    .returning({ lastNumber: teamIssueCounters.lastNumber });
  if (!counter) throw new Error(`The issue counter of team ${teamId} returned no row`);
  return counter.lastNumber;
}

/**
 * A key before the team's lowest `sort_order` (archived and deleted issues included, so no key is
 * reused), with random jitter: a new issue goes first (Q7). Call it only after
 * `nextIssueNumber` in the same transaction, which holds the team's counter lock.
 */
export async function firstSortKey(tx: NodePgDatabase, teamId: string): Promise<string> {
  const [lowest] = await tx
    .select({ sortOrder: issues.sortOrder })
    .from(issues)
    .where(eq(issues.teamId, teamId))
    // Byte order (the column is `COLLATE "C"`; said again so the order never depends on it).
    .orderBy(sql`${issues.sortOrder} COLLATE "C"`)
    .limit(1);
  return keyBefore(lowest?.sortOrder ?? null, jitterFrom(randomInt(2 ** 47)));
}

/**
 * The number and the order key of a new issue in `teamId`, in the order §4.5 needs: the counter
 * (and its lock) first, then the sort key read. `issue.create` calls this after its team, status
 * and label locks (SPEC-011 §4.8) and before inserting the issue.
 */
export async function newIssuePosition(
  tx: NodePgDatabase,
  teamId: string,
): Promise<{ readonly number: number; readonly sortOrder: string }> {
  const number = await nextIssueNumber(tx, teamId);
  const sortOrder = await firstSortKey(tx, teamId);
  return { number, sortOrder };
}
