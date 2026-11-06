/**
 * Background jobs on pg-boss (ADR-0010): a queue stored in Postgres, in its own `pgboss` schema,
 * which pg-boss creates and migrates itself under its own advisory lock. Started by the `all`
 * and `worker` roles (SPEC-004 §7). Every job is idempotent.
 */
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Pool } from '../db/pool.js';
import { pruneIdempotency } from '../executor/idempotency.js';
import { loggableError } from '../executor/log-error.js';

export const JOB_SCHEMA = 'pgboss';

/** Queue names and schedules. ADR-0010 lists the queues later milestones add. */
export const QUEUES = {
  /** Deletes `clientMutationId` results older than 24 h (SPEC-003 §9). */
  idempotencyPrune: { name: 'idempotency-prune', cron: '17 * * * *' },
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
}

export async function startJobs({
  databaseUrl,
  pool,
  log,
  pollingIntervalSeconds = 30,
}: JobOptions): Promise<Jobs> {
  const jobLog = log.child({ component: 'jobs' });
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: JOB_SCHEMA,
    application_name: 'surface-jobs',
    max: 4,
    // No telemetry leaves the process (CLAUDE.md rule 5); keep pg-boss's hooks off too.
    openTelemetry: { enabled: false },
  });
  // pg-boss reports background failures as events; an unhandled 'error' would crash the process.
  boss.on('error', (error) => jobLog.error({ err: loggableError(error) }, 'job queue error'));
  await boss.start();

  const prune = QUEUES.idempotencyPrune;
  await boss.createQueue(prune.name);
  await boss.schedule(prune.name, prune.cron);
  await boss.work(prune.name, { pollingIntervalSeconds }, async () => {
    const deleted = await pruneIdempotency(pool);
    jobLog.info({ queue: prune.name, deleted }, 'pruned idempotency keys');
  });

  return {
    boss,
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
