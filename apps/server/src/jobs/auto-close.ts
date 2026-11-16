/**
 * The `auto-close` job (SPEC-015 §6.3, AC-8): every day at 03:17 UTC, closes the live issues in a
 * Backlog, Unstarted or Started status, in teams with auto-close on (`auto_close_months` and
 * `auto_close_status_id` set), where `updatedAt + autoCloseMonths <= now`, oldest first, through
 * `issue.autoClose` as the system actor, one issue per transaction.
 *
 * Comments, reactions and attachments don't move `updatedAt`, so they don't count as activity
 * (D18). A team with no auto-close status is skipped by the selection; a setting or an issue that
 * changed after selection is re-checked under the locks by the operation (E21).
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
export interface AutoCloseItem {
  readonly id: string;
  /** `updated_at` as Postgres prints it (microseconds kept). */
  readonly at: string;
}

export interface AutoCloseDb {
  /** The stale issues at `now`, by `updated_at` then id, after `after`. */
  due(
    now: Date,
    after: AutoCloseItem | undefined,
    limit: number,
  ): Promise<readonly AutoCloseItem[]>;
}

/** The selection on Postgres. */
export function pgAutoCloseDb(pool: Pool): AutoCloseDb {
  const db = drizzle({ client: pool, casing: 'snake_case' });
  return {
    async due(now, after, limit) {
      const { rows } = await db.execute<{ id: string; at: string }>(sql`
        SELECT i.id, i.updated_at::text AS at
          FROM issues i
          JOIN teams t ON t.id = i.team_id
          JOIN workflow_statuses s ON s.id = i.status_id
         WHERE i.archived_at IS NULL AND i.deleted_at IS NULL
           AND s.category IN ('backlog', 'unstarted', 'started')
           AND t.auto_close_months IS NOT NULL AND t.auto_close_status_id IS NOT NULL
           AND ((i.updated_at AT TIME ZONE 'UTC') + make_interval(months => t.auto_close_months))
                 AT TIME ZONE 'UTC' <= ${now.toISOString()}::timestamptz
           ${
             after === undefined
               ? sql``
               : sql`AND (i.updated_at, i.id) > (${after.at}::timestamptz, ${after.id}::uuid)`
           }
         ORDER BY i.updated_at, i.id
         LIMIT ${limit}`);
      return rows;
    },
  };
}

/** `surface_auto_closed_total` and `surface_auto_close_failures_total` (§6.3). */
export function autoCloseMetrics(registry: Registry): AutoMetrics {
  return autoCounters(registry, {
    total: 'surface_auto_closed_total',
    failures: 'surface_auto_close_failures_total',
    what: 'auto-close',
  });
}

export interface AutoCloseDeps {
  readonly db: AutoCloseDb;
  readonly executor: Pick<Executor, 'execute'>;
  readonly clock: () => Date;
  readonly log: AutoLog;
  readonly metrics?: AutoMetrics;
  readonly signal?: AbortSignal;
  /** Test seams; production uses `DAILY_BATCH`. */
  readonly size?: number;
  readonly cap?: number;
}

/** One run: everything stale at the run's start, oldest first, at most 5,000. */
export function autoClose({
  db,
  executor,
  clock,
  log,
  metrics = noAutoMetrics,
  size,
  cap,
  signal,
}: AutoCloseDeps): Promise<BatchCounts> {
  const now = clock();
  return runDailyBatch<AutoCloseItem>(
    {
      select: (after, limit) => db.due(now, after, limit),
      handle: (item): Promise<ItemOutcome> =>
        runAutoOperation(executor, 'issue.autoClose', item.id, metrics, log),
    },
    {
      ...(size === undefined ? {} : { size }),
      ...(cap === undefined ? {} : { cap }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

/** The `auto-close` job for `registerDailyJob`. */
export function autoCloseJob(schedule: DailyJob['schedule'], deps: AutoCloseDeps): DailyJob {
  return { schedule, run: (signal) => autoClose({ ...deps, ...(signal ? { signal } : {}) }) };
}
