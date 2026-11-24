/**
 * Background jobs on pg-boss (ADR-0010): a queue stored in Postgres, in its own `pgboss` schema,
 * which pg-boss creates and migrates itself under its own advisory lock. The `all` and `worker`
 * roles run the jobs (SPEC-004 §7). Every role starts it as a producer: the `web` role queues
 * previews (`attachment.createFile`, SPEC-014 §4.4) and, with SMTP configured, email (PLAN-001
 * S4). Every job is idempotent, except sending email (at least once).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';
import type { Pool } from '../db/pool.js';
import { pruneIdempotency } from '../executor/idempotency.js';
import { loggableError } from '../executor/log-error.js';
import type { Executor } from '../executor/execute.js';
import type { BlobStore } from '../files/blob-store.js';
import { pgFileDb } from '../files/bytes.js';
import { previewMaker, type LoadSharp } from '../files/image.js';
import { createEmailQueue, startEmailWorker } from '../mail/job.js';
import type { SmtpSettings } from '../mail/smtp.js';
import { pruneSyncLog, SYNC_LOG_RETENTION_DAYS } from '../sync/repo.js';
import { registerDailyJob } from './daily-batch.js';
import { autoArchiveJob, autoArchiveMetrics, pgAutoArchiveDb } from './auto-archive.js';
import { autoCloseJob, autoCloseMetrics, pgAutoCloseDb } from './auto-close.js';
import { fileJobs } from './files.js';
import { pgPreviewDb, previewJobHandler } from './files-preview.js';
import { createPreviewQueue, PREVIEW_QUEUE } from './preview-queue.js';
import { pgTrashDb, trashPurgeJob, trashPurgeMetrics } from './trash-purge.js';

export const JOB_SCHEMA = 'pgboss';

/** Queue names and schedules (ADR-0024 lists the M1 queues). */
export const QUEUES = {
  /** Deletes `clientMutationId` results older than 24 h (SPEC-003 §9). */
  idempotencyPrune: { name: 'idempotency-prune', cron: '17 * * * *' },
  /** Deletes `sync_log` rows past retention (30 days); later clients resync (SPEC-002 §4.3). */
  syncLogPrune: { name: 'synclog-prune', cron: '41 3 * * *' },
  /** Deletes unneeded files and drains `blob_release` (SPEC-014 §4.6). */
  filesCleanup: { name: 'files-cleanup', cron: '23 * * * *', expireInSeconds: 30 * 60 },
  /** Removes bytes with no `files` row and stale temporary files (SPEC-014 §4.5 step 5). */
  // It reads every key on the volume: on a large one that takes a while. A run still going after
  // two hours is stuck; pg-boss expires it so the exclusive queue takes the next one.
  filesSweep: { name: 'files-sweep', cron: '53 4 * * *', expireInSeconds: 2 * 60 * 60 },
  /** Purges issues deleted 720 hours ago (SPEC-015 §6.3, D10): daily, with catch-up. */
  // pg-boss's default 15 minutes is too short: a full run is 5,000 purges, each its own
  // transaction of a few deletes (about 0.1 to 0.3 s), so 10 to 25 minutes. Two hours is several
  // full runs; a run still active then is stuck, and expiring it aborts its loop.
  trashPurge: { name: 'trash-purge', cron: '53 3 * * *', expireInSeconds: 2 * 60 * 60 },
  /** Archives closed issues past their team's period (SPEC-015 §6.3): daily, with catch-up. */
  autoArchive: { name: 'auto-archive', cron: '29 3 * * *', expireInSeconds: 2 * 60 * 60 },
  /** Closes stale issues in teams with auto-close on (SPEC-015 §6.3): daily, with catch-up. */
  autoClose: { name: 'auto-close', cron: '17 3 * * *', expireInSeconds: 2 * 60 * 60 },
} as const;

export interface Jobs {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

export interface JobOptions {
  readonly databaseUrl: string;
  /** The app's pool, which job handlers query. pg-boss keeps a small pool of its own. */
  readonly pool: Pool;
  /**
   * The uploads volume (`localBlobStore(uploadsDir(DATA_DIR))`), for the file jobs. A `worker`
   * replica mounts the same volume as the web process.
   */
  readonly blobs: BlobStore;
  /**
   * The app's executor: jobs that change synced state run operations through it as the system
   * actor (ADR-0024, CLAUDE.md rule 1), like `trash-purge`.
   */
  readonly executor: Pick<Executor, 'execute'>;
  /** The `/metrics` registry, when metrics are on: the jobs' counters and gauges go there. */
  readonly metrics?: Registry;
  /** The jobs' clock (tests pass a fake). */
  readonly clock?: () => Date;
  readonly log: Logger;
  /** Seconds between polls when a queue is idle (tests make it short). */
  readonly pollingIntervalSeconds?: number;
  /**
   * Run the scheduled jobs and the workers: the `all` and `worker` roles. The `web` role only
   * queues (previews, and email with SMTP), so it leaves this off and pg-boss's maintenance to
   * them.
   */
  readonly work?: boolean;
  /** Seconds between polls of the preview queue when idle. Default 2 (§10: a preview within 5 s). */
  readonly previewPollingIntervalSeconds?: number;
  /** How the preview job loads sharp (tests pass one that fails). Default: `import('sharp')`. */
  readonly loadSharp?: LoadSharp;
  /** With SMTP configured: every role can queue email, and those that `work` send it. */
  readonly mail?: { readonly smtp: SmtpSettings; readonly sessionSecret: string };
  /** Seconds between polls of the email queue when idle. Default: the worker's own (2 s). */
  readonly emailPollingIntervalSeconds?: number;
}

/** What `registerJobs` needs: everything but the connection string, which only pg-boss uses. */
export type JobSetup = Omit<JobOptions, 'databaseUrl'>;

/** The part of pg-boss that `registerJobs` uses. */
export type JobQueue = Pick<
  PgBoss,
  'createQueue' | 'schedule' | 'work' | 'offWork' | 'send' | 'findJobs'
>;

export async function startJobs(options: JobOptions): Promise<Jobs> {
  const work = options.work ?? true;
  const jobLog = options.log.child({ component: 'jobs' });
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: JOB_SCHEMA,
    application_name: 'surface-jobs',
    max: 4,
    // No telemetry leaves the process (CLAUDE.md rule 5); keep pg-boss's hooks off too.
    openTelemetry: { enabled: false },
    // Only queuing: no maintenance, no cron; the replicas that run jobs do both.
    ...(work ? {} : { supervise: false, schedule: false }),
  });
  // pg-boss reports background failures as events; an unhandled 'error' would crash the process.
  boss.on('error', (error) => jobLog.error({ err: loggableError(error) }, 'job queue error'));
  await boss.start();
  try {
    await registerJobs(boss, options);
  } catch (error) {
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }

  return {
    boss,
    // Stops the workers too, the email worker's included.
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}

/** Creates this role's queues and starts its schedules and workers on a started `boss`. */
export async function registerJobs(
  boss: JobQueue,
  {
    pool,
    blobs,
    executor,
    metrics,
    clock = () => new Date(),
    log,
    pollingIntervalSeconds = 30,
    work = true,
    mail,
    emailPollingIntervalSeconds,
    previewPollingIntervalSeconds = 2,
    loadSharp,
  }: JobSetup,
): Promise<void> {
  const jobLog = log.child({ component: 'jobs' });
  // Every role queues previews (SPEC-014 §4.4), the `web` role too, so every role makes the queue.
  await createPreviewQueue(boss);
  if (!work) {
    // Every role that queues email needs the queue, the `web` role too.
    if (mail) await createEmailQueue(boss);
    return;
  }

  if (mail) {
    // Creates the queue too.
    await startEmailWorker(boss, {
      smtp: mail.smtp,
      sessionSecret: mail.sessionSecret,
      log,
      ...(emailPollingIntervalSeconds === undefined
        ? {}
        : { pollingIntervalSeconds: emailPollingIntervalSeconds }),
    });
  }

  const prune = QUEUES.idempotencyPrune;
  await boss.createQueue(prune.name);
  await boss.schedule(prune.name, prune.cron);
  await boss.work(prune.name, { pollingIntervalSeconds }, async () => {
    const deleted = await pruneIdempotency(pool);
    jobLog.info({ queue: prune.name, deleted }, 'pruned idempotency keys');
  });

  const syncPrune = QUEUES.syncLogPrune;
  await boss.createQueue(syncPrune.name);
  await boss.schedule(syncPrune.name, syncPrune.cron);
  await boss.work(syncPrune.name, { pollingIntervalSeconds }, async () => {
    const before = new Date(Date.now() - SYNC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await pruneSyncLog(drizzle({ client: pool, casing: 'snake_case' }), before);
    jobLog.info({ queue: syncPrune.name, deleted }, 'pruned sync log');
  });

  // One run at a time across replicas (ADR-0024): an `exclusive` queue holds one job queued or
  // active, and the schedule's `singletonKey` names it. Two runs at once would still be safe.
  const files = fileJobs({ db: pgFileDb(pool), blobs, log: jobLog });
  for (const [queue, run] of [
    [QUEUES.filesCleanup, files.cleanup],
    [QUEUES.filesSweep, files.sweep],
  ] as const) {
    await boss.createQueue(queue.name, {
      policy: 'exclusive',
      expireInSeconds: queue.expireInSeconds,
    });
    await boss.schedule(queue.name, queue.cron, null, { singletonKey: queue.name });
    await boss.work(queue.name, { pollingIntervalSeconds }, () => run(queue.name));
  }

  // SPEC-014 §4.4: one preview at a time per process (`batchSize` 1, pg-boss's one local worker),
  // its decode on the process's shared limiter.
  const preview = previewJobHandler({
    db: pgPreviewDb(pool),
    files: pgFileDb(pool),
    blobs,
    executor,
    make: previewMaker(jobLog, loadSharp),
    log: jobLog,
  });
  await boss.work(
    PREVIEW_QUEUE.name,
    { pollingIntervalSeconds: previewPollingIntervalSeconds, batchSize: 1 },
    // One job per call; the outcome is stored as the job's output.
    async ([job]) => (job === undefined ? undefined : preview(job.data)),
  );

  // SPEC-015 §6.3: the daily issue jobs, one run at a time across replicas, caught up on start.
  const trashDb = pgTrashDb(pool);
  await registerDailyJob(
    boss,
    trashPurgeJob(QUEUES.trashPurge, {
      db: trashDb,
      executor,
      clock,
      log: jobLog,
      ...(metrics ? { metrics: trashPurgeMetrics(metrics, trashDb, jobLog, clock) } : {}),
    }),
    { clock, log: jobLog, pollingIntervalSeconds },
  );
  await registerDailyJob(
    boss,
    autoCloseJob(QUEUES.autoClose, {
      db: pgAutoCloseDb(pool),
      executor,
      clock,
      log: jobLog,
      ...(metrics ? { metrics: autoCloseMetrics(metrics) } : {}),
    }),
    { clock, log: jobLog, pollingIntervalSeconds },
  );
  await registerDailyJob(
    boss,
    autoArchiveJob(QUEUES.autoArchive, {
      db: pgAutoArchiveDb(pool),
      executor,
      clock,
      log: jobLog,
      ...(metrics ? { metrics: autoArchiveMetrics(metrics) } : {}),
    }),
    { clock, log: jobLog, pollingIntervalSeconds },
  );
}
