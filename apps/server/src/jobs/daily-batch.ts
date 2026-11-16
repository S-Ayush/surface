/**
 * The daily batch jobs of SPEC-015 §6.3 (`trash-purge` here; `auto-archive` and `auto-close` in
 * PLAN-015 S3): one shape for all three.
 *
 * - **Schedule:** a cron in UTC on an `exclusive` queue, with `singletonKey` = the queue's name, so
 *   at most one run is queued or active across worker replicas (ADR-0024).
 * - **Catch-up:** when a worker starts and the queue's last completed run is older than 24 h (or
 *   pg-boss no longer remembers one), it sends one run with the same `singletonKey`. Two workers
 *   starting at once send two, and the exclusive queue keeps one.
 * - **Batches:** items are selected oldest first, `DAILY_BATCH.size` at a time, after the last one
 *   handled (a keyset cursor, so an item that failed is not selected again in the same run), at
 *   most `DAILY_BATCH.cap` per run; the rest wait for the next run. Each item is one operation,
 *   in its own transaction, through the executor as the system actor, so a crash mid-run leaves
 *   only finished items done, and the next run selects what is left.
 *
 * Time comes from a clock and pg-boss from a narrow queue interface, so tests use fakes.
 */
import type { PgBoss } from 'pg-boss';

/** SPEC-015 §6.3, D10: 100 per batch, 5,000 per run. */
export const DAILY_BATCH = { size: 100, cap: 5_000 } as const;

/** A worker that starts later than this after the last completed run sends a catch-up run. */
export const CATCH_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/** What a daily job needs of pg-boss. */
export type DailyQueue = Pick<PgBoss, 'createQueue' | 'schedule' | 'work' | 'send' | 'findJobs'>;

/** A queue name and its cron (UTC). */
export interface DailySchedule {
  readonly name: string;
  readonly cron: string;
}

/** What happened to one item: done (or already gone), left alone, or failed (tried next run). */
export type ItemOutcome = 'done' | 'skipped' | 'failed';

export interface BatchCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface DailyBatch<T> {
  /** Up to `limit` items due now, oldest first, strictly after `after` (from the start if absent). */
  select(after: T | undefined, limit: number): Promise<readonly T[]>;
  /** Handles one item, in its own transaction. Never throws for one item's failure. */
  handle(item: T): Promise<ItemOutcome>;
}

/** Runs one batch job: batches of `size`, at most `cap` items, until nothing more is due. */
export async function runDailyBatch<T>(
  batch: DailyBatch<T>,
  { size = DAILY_BATCH.size, cap = DAILY_BATCH.cap }: { size?: number; cap?: number } = {},
): Promise<BatchCounts> {
  const counts = { done: 0, skipped: 0, failed: 0 };
  let handled = 0;
  let after: T | undefined;
  while (handled < cap) {
    const limit = Math.min(size, cap - handled);
    const items = await batch.select(after, limit);
    for (const item of items) {
      counts[await batch.handle(item)] += 1;
      handled += 1;
    }
    after = items.at(-1);
    if (items.length < limit) break;
  }
  return counts;
}

/**
 * Sends one run of `name` when its last completed run finished more than 24 h before `now`, or
 * pg-boss keeps none (it deletes completed jobs after a week). Returns whether it sent one.
 */
export async function catchUp(
  queue: Pick<DailyQueue, 'findJobs' | 'send'>,
  name: string,
  now: Date,
): Promise<boolean> {
  const jobs = await queue.findJobs(name);
  const last = jobs.reduce<number | undefined>((latest, job) => {
    if (job.state !== 'completed' || job.completedOn === null) return latest;
    const at = job.completedOn.getTime();
    return latest === undefined || at > latest ? at : latest;
  }, undefined);
  if (last !== undefined && now.getTime() - last <= CATCH_UP_AFTER_MS) return false;
  await queue.send(name, null, { singletonKey: name });
  return true;
}

export interface DailyJob {
  readonly schedule: DailySchedule;
  /** One run. Its counts are logged; a throw fails the job (pg-boss retries it). */
  run(): Promise<BatchCounts>;
}

/**
 * Creates the exclusive queue, schedules it with its `singletonKey`, starts its worker, then
 * catches up. PLAN-015 S3 registers `auto-archive` and `auto-close` the same way.
 */
export async function registerDailyJob(
  queue: DailyQueue,
  job: DailyJob,
  {
    clock,
    log,
    pollingIntervalSeconds,
  }: {
    readonly clock: () => Date;
    readonly log: { info(object: object, message: string): void };
    readonly pollingIntervalSeconds: number;
  },
): Promise<void> {
  const { name, cron } = job.schedule;
  await queue.createQueue(name, { policy: 'exclusive' });
  await queue.schedule(name, cron, null, { singletonKey: name });
  await queue.work(name, { pollingIntervalSeconds }, async () => {
    const counts = await job.run();
    log.info({ queue: name, ...counts }, 'daily job finished');
  });
  if (await catchUp(queue, name, clock())) {
    log.info({ queue: name }, 'daily job queued to catch up');
  }
}
