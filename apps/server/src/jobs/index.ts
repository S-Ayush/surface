/**
 * Background jobs on pg-boss (ADR-0010): a queue stored in Postgres, in its own `pgboss` schema,
 * which pg-boss creates and migrates itself under its own advisory lock. The `all` and `worker`
 * roles run the jobs (SPEC-004 §7); with SMTP configured the `web` role starts it too, only to
 * queue email (PLAN-001 S4). Every job is idempotent, except sending email (at least once).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Pool } from '../db/pool.js';
import { pruneIdempotency } from '../executor/idempotency.js';
import { loggableError } from '../executor/log-error.js';
import { createEmailQueue, startEmailWorker } from '../mail/job.js';
import type { SmtpSettings } from '../mail/smtp.js';
import { pruneSyncLog, SYNC_LOG_RETENTION_DAYS } from '../sync/repo.js';

export const JOB_SCHEMA = 'pgboss';

/** Queue names and schedules. ADR-0010 lists the queues later milestones add. */
export const QUEUES = {
  /** Deletes `clientMutationId` results older than 24 h (SPEC-003 §9). */
  idempotencyPrune: { name: 'idempotency-prune', cron: '17 * * * *' },
  /** Deletes `sync_log` rows past retention (30 days); later clients resync (SPEC-002 §4.3). */
  syncLogPrune: { name: 'synclog-prune', cron: '41 3 * * *' },
} as const;

export interface Jobs {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

export interface JobOptions {
  readonly databaseUrl: string;
  /** The app's pool, which job handlers query. pg-boss keeps a small pool of its own. */
  readonly pool: Pool;
  readonly log: Logger;
  /** Seconds between polls when a queue is idle (tests make it short). */
  readonly pollingIntervalSeconds?: number;
  /**
   * Run the scheduled jobs and the workers: the `all` and `worker` roles. The `web` role only
   * queues email, so it leaves this off and pg-boss's maintenance to them.
   */
  readonly work?: boolean;
  /** With SMTP configured: every role can queue email, and those that `work` send it. */
  readonly mail?: { readonly smtp: SmtpSettings; readonly sessionSecret: string };
  /** Seconds between polls of the email queue when idle. Default: the worker's own (2 s). */
  readonly emailPollingIntervalSeconds?: number;
}

/** What `registerJobs` needs: everything but the connection string, which only pg-boss uses. */
export type JobSetup = Omit<JobOptions, 'databaseUrl'>;

/** The part of pg-boss that `registerJobs` uses. */
export type JobQueue = Pick<PgBoss, 'createQueue' | 'schedule' | 'work' | 'offWork'>;

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
    log,
    pollingIntervalSeconds = 30,
    work = true,
    mail,
    emailPollingIntervalSeconds,
  }: JobSetup,
): Promise<void> {
  const jobLog = log.child({ component: 'jobs' });
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
}
