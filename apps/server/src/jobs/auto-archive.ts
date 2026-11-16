/**
 * The `auto-archive` job (SPEC-015 §6.3, AC-7): every day at 03:29 UTC, archives the live issues
 * in a Completed, Canceled or Duplicate status where `greatest(completedAt, canceledAt, updatedAt)
 * + autoArchiveMonths <= now`, with the months from the issue's own team, oldest first, through
 * `issue.autoArchive` as the system actor, one issue per transaction (`daily-batch.ts` has the
 * batches, the cap and the catch-up).
 *
 * - **Boundary:** `now` is the app clock at the run's start (D20), the same clock the operation
 *   re-checks under the issue lock (E20, E21). Month arithmetic is in UTC, with Postgres's
 *   end-of-month clamping, like `autoArchiveDueAt` in the domain.
 * - **Including `updatedAt`** gives a restored or edited issue a fresh period (§4.2, E20).
 * - **A lowered period** archives the backlog 5,000 a run (E19).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Registry } from 'prom-client';
import type { Pool } from '../db/pool.js';
import type { Executor } from '../executor/execute.js';
import {
  autoCounters,
  noAutoMetrics,
  runAutoOperation,
  type AutoLog,
  type AutoMetrics,
} from './auto-lifecycle.js';
import { runDailyBatch, type BatchCounts, type DailyJob, type ItemOutcome } from './daily-batch.js';

/** One selected issue: the keyset cursor of the selection. */
export interface AutoArchiveItem {
  readonly id: string;
  /** `greatest(completed_at, canceled_at, updated_at)` as Postgres prints it (microseconds kept). */
  readonly at: string;
}

export interface AutoArchiveDb {
  /** The issues due at `now`, by last activity then id, after `after`. */
  due(
    now: Date,
    after: AutoArchiveItem | undefined,
    limit: number,
  ): Promise<readonly AutoArchiveItem[]>;
}

/** The selection on Postgres. */
export function pgAutoArchiveDb(pool: Pool): AutoArchiveDb {
  const db = drizzle({ client: pool, casing: 'snake_case' });
  return {
    async due(now, after, limit) {
      const at = sql`greatest(i.completed_at, i.canceled_at, i.updated_at)`;
      // `AT TIME ZONE 'UTC'` both ways pins the month arithmetic to UTC, whatever the session's.
      const { rows } = await db.execute<{ id: string; at: string }>(sql`
        SELECT i.id, ${at}::text AS at
          FROM issues i
          JOIN teams t ON t.id = i.team_id
          JOIN workflow_statuses s ON s.id = i.status_id
         WHERE i.archived_at IS NULL AND i.deleted_at IS NULL
           AND s.category IN ('completed', 'canceled', 'duplicate')
           AND ((${at} AT TIME ZONE 'UTC') + make_interval(months => t.auto_archive_months))
                 AT TIME ZONE 'UTC' <= ${now.toISOString()}::timestamptz
           ${
             after === undefined
               ? sql``
               : sql`AND (${at}, i.id) > (${after.at}::timestamptz, ${after.id}::uuid)`
           }
         ORDER BY ${at}, i.id
         LIMIT ${limit}`);
      return rows;
    },
  };
}

/** `surface_auto_archived_total` and `surface_auto_archive_failures_total` (§6.3). */
export function autoArchiveMetrics(registry: Registry): AutoMetrics {
  return autoCounters(registry, {
    total: 'surface_auto_archived_total',
    failures: 'surface_auto_archive_failures_total',
    what: 'auto-archive',
  });
}

export interface AutoArchiveDeps {
  readonly db: AutoArchiveDb;
  readonly executor: Pick<Executor, 'execute'>;
  readonly clock: () => Date;
  readonly log: AutoLog;
  readonly metrics?: AutoMetrics;
  /** The job's abort signal: the run stops before its next issue (`runDailyBatch`). */
  readonly signal?: AbortSignal;
  /** Test seams; production uses `DAILY_BATCH`. */
  readonly size?: number;
  readonly cap?: number;
}

/** One run: everything due at the run's start, oldest first, at most 5,000. */
export function autoArchive({
  db,
  executor,
  clock,
  log,
  metrics = noAutoMetrics,
  size,
  cap,
  signal,
}: AutoArchiveDeps): Promise<BatchCounts> {
  const now = clock();
  return runDailyBatch<AutoArchiveItem>(
    {
      select: (after, limit) => db.due(now, after, limit),
      handle: (item): Promise<ItemOutcome> =>
        runAutoOperation(executor, 'issue.autoArchive', item.id, metrics, log),
    },
    {
      ...(size === undefined ? {} : { size }),
      ...(cap === undefined ? {} : { cap }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

/** The `auto-archive` job for `registerDailyJob`. */
export function autoArchiveJob(schedule: DailyJob['schedule'], deps: AutoArchiveDeps): DailyJob {
  return { schedule, run: (signal) => autoArchive({ ...deps, ...(signal ? { signal } : {}) }) };
}
