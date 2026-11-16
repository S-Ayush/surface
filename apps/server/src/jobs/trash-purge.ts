/**
 * The `trash-purge` job (SPEC-015 §6.3, AC-6): every day at 03:53 UTC, purges the issues deleted
 * 720 hours ago or more, oldest first, through `issue.purge` as the system actor, one issue per
 * transaction (`daily-batch.ts` has the batches, the cap and the catch-up).
 *
 * - **Selection:** `deleted_at + 720 h <= now`, the same boundary as `purgeAfter` (§4.2): at
 *   exactly `purgeAfter` an issue can't be restored and may be purged.
 * - **Idempotent:** an issue already gone is `NOT_FOUND`, which counts as done; one restored after
 *   it was selected is `CONFLICT`, which the job leaves alone (skipped). Anything else is a
 *   failure, counted and logged, and the next run tries the issue again.
 * - **Bytes** are not removed here: `files-cleanup` drains the keys a purge records (§4.5).
 */
import { RETENTION_HOURS, systemActor } from '@surface/domain';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Counter, Gauge, type Registry } from 'prom-client';
import type { Pool } from '../db/pool.js';
import type { Executor } from '../executor/execute.js';
import { loggableError } from '../executor/log-error.js';
import { runDailyBatch, type BatchCounts, type DailyJob, type ItemOutcome } from './daily-batch.js';

/** One selected issue: the keyset cursor of the selection. */
export interface TrashItem {
  readonly id: string;
  /** `deleted_at` as Postgres prints it, so the cursor round-trips without losing microseconds. */
  readonly deletedAt: string;
}

export interface TrashDb {
  /** Issues with `deleted_at + 720 h <= now`, by `deleted_at` then id, after `after`. */
  due(now: Date, after: TrashItem | undefined, limit: number): Promise<readonly TrashItem[]>;
  /** The oldest `deleted_at` of any issue, for the age gauge; undefined when none is deleted. */
  oldestDeletedAt(): Promise<Date | undefined>;
}

/** The selection on Postgres; the partial index `issues_deleted_at_idx` serves it (§4.9). */
export function pgTrashDb(pool: Pool): TrashDb {
  const db = drizzle({ client: pool, casing: 'snake_case' });
  return {
    async due(now, after, limit) {
      // `deleted_at <= now - 720 h` is `deleted_at + 720 h <= now`, in a form the index serves.
      const cutoff = sql`${now.toISOString()}::timestamptz - make_interval(hours => ${RETENTION_HOURS})`;
      const { rows } = await db.execute<{ id: string; deleted_at: string }>(sql`
        SELECT id, deleted_at::text AS deleted_at FROM issues
         WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff}
           ${
             after === undefined
               ? sql``
               : sql`AND (deleted_at, id) > (${after.deletedAt}::timestamptz, ${after.id}::uuid)`
           }
         ORDER BY deleted_at, id
         LIMIT ${limit}`);
      return rows.map((row) => ({ id: row.id, deletedAt: row.deleted_at }));
    },
    async oldestDeletedAt() {
      const { rows } = await db.execute<{ oldest: string | null }>(
        sql`SELECT min(deleted_at)::text AS oldest FROM issues WHERE deleted_at IS NOT NULL`,
      );
      const oldest = rows[0]?.oldest;
      return oldest === null || oldest === undefined ? undefined : new Date(oldest);
    },
  };
}

/** `surface_trash_*` (SPEC-015 §6.3, NFR-24). */
export interface TrashPurgeMetrics {
  purged(): void;
  failed(): void;
}

export const noTrashPurgeMetrics: TrashPurgeMetrics = {
  purged: () => undefined,
  failed: () => undefined,
};

/**
 * The two counters, and the age of the oldest deleted issue, read on each scrape. A job that
 * stopped running shows as an age past 30 days.
 */
export function trashPurgeMetrics(
  registry: Registry,
  db: Pick<TrashDb, 'oldestDeletedAt'>,
  clock: () => Date = () => new Date(),
): TrashPurgeMetrics {
  const purged = new Counter({
    name: 'surface_trash_purged_total',
    help: 'Deleted issues the trash-purge job purged for good',
    registers: [registry],
  });
  const failures = new Counter({
    name: 'surface_trash_purge_failures_total',
    help: 'Issues the trash-purge job failed to purge; it tries them again on its next run',
    registers: [registry],
  });
  new Gauge({
    name: 'surface_trash_oldest_deleted_age_seconds',
    help: 'Age of the oldest deleted issue in seconds, 0 when none is deleted',
    registers: [registry],
    async collect() {
      const oldest = await db.oldestDeletedAt();
      this.set(oldest === undefined ? 0 : (clock().getTime() - oldest.getTime()) / 1000);
    },
  });
  return { purged: () => purged.inc(), failed: () => failures.inc() };
}

export interface TrashPurgeDeps {
  readonly db: TrashDb;
  readonly executor: Pick<Executor, 'execute'>;
  readonly clock: () => Date;
  readonly log: { warn(object: object, message: string): void };
  readonly metrics?: TrashPurgeMetrics;
  /** Test seams; production uses `DAILY_BATCH`. */
  readonly size?: number;
  readonly cap?: number;
}

/** One run: everything due at the run's start, oldest first, at most 5,000. */
export function purgeTrash({
  db,
  executor,
  clock,
  log,
  metrics = noTrashPurgeMetrics,
  size,
  cap,
}: TrashPurgeDeps): Promise<BatchCounts> {
  const now = clock();
  return runDailyBatch<TrashItem>(
    {
      select: (after, limit) => db.due(now, after, limit),
      async handle(item): Promise<ItemOutcome> {
        let code: string;
        try {
          const result = await executor.execute('issue.purge', { issue: item.id }, systemActor());
          if (result.ok) {
            metrics.purged();
            return 'done';
          }
          code = result.error.code;
        } catch (error) {
          // The executor answers every operation error; a throw is the pool or the process.
          log.warn(
            { issueId: item.id, err: loggableError(error) },
            'trash-purge failed on an issue',
          );
          metrics.failed();
          return 'failed';
        }
        // Purged meanwhile (by an Admin, or a run that crashed after its commit).
        if (code === 'NOT_FOUND') return 'done';
        // Restored after it was selected: no longer due.
        if (code === 'CONFLICT') return 'skipped';
        metrics.failed();
        // The executor logged the cause with its correlation id; the issue id is enough here.
        log.warn({ issueId: item.id, code }, 'trash-purge could not purge an issue');
        return 'failed';
      },
    },
    { ...(size === undefined ? {} : { size }), ...(cap === undefined ? {} : { cap }) },
  );
}

/** The `trash-purge` job for `registerDailyJob`. */
export function trashPurgeJob(schedule: DailyJob['schedule'], deps: TrashPurgeDeps): DailyJob {
  return { schedule, run: () => purgeTrash(deps) };
}
