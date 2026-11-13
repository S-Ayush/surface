// ADR-0010 / PLAN-003 S6: pg-boss starts in its own schema, schedules the idempotency prune,
// and the prune job deletes only expired `clientMutationId` results.
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { memoryBlobStore } from '../src/files/blob-store.js';
import { JOB_SCHEMA, QUEUES, startJobs, type Jobs } from '../src/jobs/index.js';
import { createTestDatabase, silentLog, type TestDatabase } from './db.js';

let db: TestDatabase;
let jobs: Jobs;
beforeAll(async () => {
  db = await createTestDatabase();
  jobs = await startJobs({
    databaseUrl: db.url,
    pool: db.pool,
    blobs: memoryBlobStore(),
    log: silentLog,
    pollingIntervalSeconds: 0.5,
  });
});
afterAll(async () => {
  await jobs.stop();
  await db.drop();
});

async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(50);
  }
}

it('installs its own schema and schedules the hourly prune', async () => {
  const { rowCount } = await db.pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
    JOB_SCHEMA,
  ]);
  expect(rowCount).toBe(1);
  const schedules = await jobs.boss.getSchedules(QUEUES.idempotencyPrune.name);
  expect(schedules.map((s) => s.cron)).toEqual([QUEUES.idempotencyPrune.cron]);
});

it('schedules the file jobs on exclusive queues (PLAN-014 S3, ADR-0024)', async () => {
  for (const queue of [QUEUES.filesCleanup, QUEUES.filesSweep]) {
    const schedules = await jobs.boss.getSchedules(queue.name);
    expect(schedules.map((s) => s.cron)).toEqual([queue.cron]);
    const created = await jobs.boss.getQueue(queue.name);
    expect(created?.policy).toBe('exclusive');
    expect(created?.expireInSeconds).toBe(queue.expireInSeconds);
    // And the worker runs it to completion on an empty store.
    const id = await jobs.boss.send(queue.name, null, { singletonKey: queue.name });
    expect(id).not.toBeNull();
    await until(async () => {
      const job = await jobs.boss.getJobById(queue.name, id ?? '');
      return job?.state === 'completed';
    }, `the ${queue.name} job to complete`);
  }
});

it('prunes expired idempotency results when the job runs', async () => {
  await db.pool.query(`
    INSERT INTO api_idempotency (actor_id, client_mutation_id, operation, result, created_at)
    VALUES ('user:a', 'old', 'debug.touch', '{}', now() - interval '25 hours'),
           ('user:a', 'new', 'debug.touch', '{}', now())`);

  const id = await jobs.boss.send(QUEUES.idempotencyPrune.name);
  expect(id).not.toBeNull();
  await until(async () => {
    const job = await jobs.boss.getJobById(QUEUES.idempotencyPrune.name, id ?? '');
    return job?.state === 'completed';
  }, 'the prune job to complete');

  const { rows } = await db.pool.query<{ client_mutation_id: string }>(
    'SELECT client_mutation_id FROM api_idempotency ORDER BY 1',
  );
  expect(rows.map((r) => r.client_mutation_id)).toEqual(['new']);
});
