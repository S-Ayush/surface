// PLAN-001 S4 wiring (session E's handoff): which queues and workers each role runs, and the
// outbox that routes and handlers queue email through. Against a recording pg-boss stand-in; the
// real queue is covered by `jobs.int.test.ts` and E's checks by hand (PLAN-001 S4 As built).
import type { PoolClient } from 'pg';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import { memoryBlobStore } from '../src/files/blob-store.js';
import { emailOutbox, NO_EMAIL } from '../src/jobs/email.js';
import { QUEUES, registerJobs, type JobQueue } from '../src/jobs/index.js';
import { EMAIL_QUEUE, type EmailJob, type JobSender } from '../src/mail/job.js';

const SECRET = 'a'.repeat(64);
const MAIL = {
  smtp: { url: 'smtp://mail.example.com:587', from: 'Surface <surface@example.com>' },
  sessionSecret: SECRET,
};
const EMAIL: EmailJob = {
  template: 'magicLink',
  to: 'ada@example.com',
  workspaceName: 'Acme',
  link: 'https://surface.example.com/auth/magic?token=magic-token-5f0c2a9e7b1d4c3a',
};

/** Records what a role sets up on pg-boss. */
function recordingQueue() {
  const created: string[] = [];
  const scheduled: string[] = [];
  const workers: string[] = [];
  const queue: JobQueue = {
    createQueue: vi.fn((name: string) => {
      created.push(name);
      return Promise.resolve();
    }),
    schedule: vi.fn((name: string) => {
      scheduled.push(name);
      return Promise.resolve();
    }),
    work: vi.fn((name: string) => {
      workers.push(name);
      return Promise.resolve(`worker-${name}`);
    }),
    offWork: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve('job-1')),
    // No completed runs: the daily jobs catch up (PLAN-015 S2).
    findJobs: vi.fn(() => Promise.resolve([])),
  };
  return { queue, created, scheduled, workers };
}

const base = {
  pool: {} as Pool,
  blobs: memoryBlobStore(),
  executor: { execute: () => Promise.reject(new Error('no operation runs here')) },
  log: pino({ level: 'silent' }),
};
// The scheduled jobs every working role runs: the prunes, the file jobs (PLAN-014 S3) and the
// trash purge (PLAN-015 S2).
const PRUNES = [
  QUEUES.idempotencyPrune.name,
  QUEUES.syncLogPrune.name,
  QUEUES.filesCleanup.name,
  QUEUES.filesSweep.name,
  QUEUES.trashPurge.name,
  QUEUES.autoArchive.name,
  QUEUES.autoClose.name,
];

describe('registerJobs', () => {
  it('lets the web role queue email without sending it or running any job', async () => {
    const r = recordingQueue();
    await registerJobs(r.queue, { ...base, work: false, mail: MAIL });
    expect(r.created).toEqual([EMAIL_QUEUE]);
    expect(r.workers).toEqual([]);
    expect(r.scheduled).toEqual([]);
  });

  it('sends email where jobs run, next to the scheduled prunes', async () => {
    const r = recordingQueue();
    await registerJobs(r.queue, { ...base, mail: MAIL });
    expect(r.created).toContain(EMAIL_QUEUE);
    expect(r.workers.sort()).toEqual([EMAIL_QUEUE, ...PRUNES].sort());
    expect(r.scheduled.sort()).toEqual([...PRUNES].sort());
  });

  it('runs the file jobs one at a time across replicas (ADR-0024)', async () => {
    const r = recordingQueue();
    await registerJobs(r.queue, base);
    for (const queue of [QUEUES.filesCleanup, QUEUES.filesSweep]) {
      expect(r.queue.createQueue).toHaveBeenCalledWith(queue.name, {
        policy: 'exclusive',
        expireInSeconds: queue.expireInSeconds,
      });
      expect(r.queue.schedule).toHaveBeenCalledWith(queue.name, queue.cron, null, {
        singletonKey: queue.name,
      });
    }
    expect(QUEUES.filesCleanup.cron).toBe('23 * * * *'); // hourly
    expect(QUEUES.filesSweep.cron).toBe('53 4 * * *'); // daily
    // A stuck run expires, so the exclusive queue takes the next one.
    expect(QUEUES.filesCleanup.expireInSeconds).toBe(30 * 60);
    expect(QUEUES.filesSweep.expireInSeconds).toBe(2 * 60 * 60);
  });

  it('has no email queue or worker without SMTP', async () => {
    const r = recordingQueue();
    await registerJobs(r.queue, base);
    expect(r.created).not.toContain(EMAIL_QUEUE);
    expect(r.workers.sort()).toEqual([...PRUNES].sort());
  });
});

describe('emailOutbox', () => {
  /** Records `send` calls the way pg-boss receives them. */
  function fakeSender() {
    const calls: { name: string; data: unknown; options: unknown }[] = [];
    const sender: JobSender = {
      send: vi.fn((...args: unknown[]) => {
        const [name, data, options] = args;
        calls.push({ name: String(name), data, options });
        return Promise.resolve('job-1');
      }),
    };
    return { sender, calls };
  }

  it('queues a sealed email on the caller’s connection', async () => {
    const { sender, calls } = fakeSender();
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const client = { query } as unknown as PoolClient;
    const outbox = emailOutbox({ enabled: true, sessionSecret: SECRET, sender: () => sender });

    await expect(outbox.enqueue(client, EMAIL)).resolves.toBe(true);
    expect(calls.map((c) => c.name)).toEqual([EMAIL_QUEUE]);
    // pg-boss runs its INSERT through `db`, which is the caller's connection.
    const db = (calls[0]?.options as { db: { executeSql(t: string, v: unknown[]): unknown } }).db;
    await db.executeSql('INSERT …', [1]);
    expect(query).toHaveBeenCalledWith('INSERT …', [1]);
    // Neither the address nor the link is readable in what the queue stores.
    expect(JSON.stringify(calls[0]?.data)).not.toMatch(/ada@example\.com|magic-token/);
  });

  it('queues nothing without SMTP, and says so', async () => {
    const { sender, calls } = fakeSender();
    const client = { query: vi.fn() } as unknown as PoolClient;
    const outbox = emailOutbox({ enabled: false, sessionSecret: SECRET, sender: () => sender });
    expect(outbox.enabled).toBe(false);
    await expect(outbox.enqueue(client, EMAIL)).resolves.toBe(false);
    await expect(NO_EMAIL.enqueue(client, EMAIL)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails loudly if asked to queue before startup started the queue', async () => {
    const client = { query: vi.fn() } as unknown as PoolClient;
    const outbox = emailOutbox({ enabled: true, sessionSecret: SECRET, sender: () => undefined });
    await expect(outbox.enqueue(client, EMAIL)).rejects.toThrow('has not started');
  });
});
