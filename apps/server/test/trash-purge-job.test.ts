// PLAN-015 S2, SPEC-015 §6.3: AC-6 (the `trash-purge` job selects exactly the issues with
// `deleted_at + 720 h <= now`, exact boundary included; purges in batches of 100, through
// `issue.purge` as the system actor; resumes after a crash without purging anything twice; stops
// at 5,000 a run; a second start with the same `singletonKey` doesn't run it twice), E4's job
// half (an issue past `purgeAfter` is purged on the next run), and the job's metrics. A fake
// clock, executor, queue and selection; the selection's SQL is checked as text.
import { purgeAfter, RETENTION_HOURS, type Actor } from '@surface/domain';
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import type { ExecuteResult } from '../src/executor/execute.js';
import {
  CATCH_UP_AFTER_MS,
  DAILY_BATCH,
  catchUp,
  registerDailyJob,
  type DailyQueue,
} from '../src/jobs/daily-batch.js';
import { QUEUES } from '../src/jobs/index.js';
import {
  pgTrashDb,
  purgeTrash,
  trashPurgeJob,
  trashPurgeMetrics,
  type TrashDb,
  type TrashItem,
} from '../src/jobs/trash-purge.js';
import type { Statement } from './support/scripted-db.js';

const NOW = new Date('2026-11-16T03:53:00.000Z');
const HOUR = 60 * 60 * 1000;
const RETENTION_MS = RETENTION_HOURS * HOUR;

const idOf = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/**
 * The deleted issues, by id, and the selection over them: due when `purgeAfter <= now` (the
 * domain's boundary, §4.2), oldest first, by `deletedAt` then id, after the cursor.
 */
function fakeTrash(deleted: Map<string, Date>) {
  const selects: { after?: string; limit: number }[] = [];
  let failSelectAt: number | undefined;
  const db: TrashDb = {
    due(now, after, limit) {
      selects.push({ ...(after ? { after: after.id } : {}), limit });
      if (failSelectAt !== undefined && selects.length === failSelectAt) {
        return Promise.reject(new Error('worker crashed'));
      }
      const key = (item: TrashItem) => `${item.deletedAt}|${item.id}`;
      const due = [...deleted]
        .filter(([, at]) => purgeAfter(at).getTime() <= now.getTime())
        .map(([id, at]): TrashItem => ({ id, deletedAt: at.toISOString() }))
        .sort((a, b) => key(a).localeCompare(key(b)))
        .filter((item) => after === undefined || key(item) > key(after));
      return Promise.resolve(due.slice(0, limit));
    },
    oldestDeletedAt() {
      const times = [...deleted.values()].map((d) => d.getTime());
      return Promise.resolve(times.length === 0 ? undefined : new Date(Math.min(...times)));
    },
  };
  return {
    db,
    selects,
    crashOnSelect: (n: number | undefined) => {
      failSelectAt = n;
    },
  };
}

/** `issue.purge` on the fake trash: answers as the executor does, and counts each purge. */
function fakeExecutor(
  deleted: Map<string, Date>,
  answer: (id: string) => ExecuteResult | undefined = () => undefined,
) {
  const purged: string[] = [];
  const actors: Actor[] = [];
  const execute = vi.fn((op: string, input: unknown, actor: Actor): Promise<ExecuteResult> => {
    actors.push(actor);
    const id = String(Reflect.get(Object(input), 'issue'));
    if (op !== 'issue.purge') throw new Error(`unexpected ${op}`);
    const scripted = answer(id);
    if (scripted !== undefined) return Promise.resolve(scripted);
    if (!deleted.delete(id)) return Promise.resolve(failure('NOT_FOUND'));
    purged.push(id);
    return Promise.resolve({ ok: true, result: { purged: true } });
  });
  return { executor: { execute }, purged, actors };
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'): ExecuteResult {
  return { ok: false, error: { code, message: code, correlationId: 'c-1' } };
}

const silent = { warn: vi.fn(), info: vi.fn() };

/** `count` issues deleted long enough ago, one minute apart, oldest first. */
function deletedIssues(count: number, base = new Date(NOW.getTime() - RETENTION_MS - HOUR)) {
  return new Map(
    Array.from({ length: count }, (_, n) => [
      idOf(n + 1),
      new Date(base.getTime() - (count - n) * 60_000),
    ]),
  );
}

describe('the trash-purge selection (AC-6)', () => {
  it('purges an issue at exactly purgeAfter and not 1 ms before it, nor a live one (E4)', async () => {
    const atBoundary = idOf(1);
    const justBefore = idOf(2);
    const deleted = new Map([
      [atBoundary, new Date(NOW.getTime() - RETENTION_MS)],
      [justBefore, new Date(NOW.getTime() - RETENTION_MS + 1)],
    ]);
    const trash = fakeTrash(deleted);
    const { executor, purged, actors } = fakeExecutor(deleted);
    const counts = await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(purged).toEqual([atBoundary]);
    expect(counts).toEqual({ done: 1, skipped: 0, failed: 0 });
    // Through the executor, as the system actor (§6.3).
    expect(actors.map((a) => a.kind)).toEqual(['system']);
    // The one left is purged on a later run, once it is due.
    const later = await purgeTrash({
      db: trash.db,
      executor,
      clock: () => new Date(NOW.getTime() + 1),
      log: silent,
    });
    expect(later.done).toBe(1);
    expect(purged).toEqual([atBoundary, justBefore]);
  });

  it('selects in Postgres with deleted_at <= now - 720 hours, oldest first, after the cursor', async () => {
    const statements: Statement[] = [];
    const pool = {
      query(config: { text: string }, params: unknown[] = []) {
        statements.push({ text: config.text, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db = pgTrashDb(pool as unknown as Pool);
    await db.due(NOW, undefined, 100);
    await db.due(NOW, { id: idOf(7), deletedAt: '2026-10-01 10:00:00.123456+00' }, 50);
    const [first, second] = statements;
    const flat = (text = '') => text.replace(/\s+/g, ' ');
    expect(flat(first?.text)).toMatch(
      /WHERE deleted_at IS NOT NULL AND deleted_at <= \$1::timestamptz - make_interval\(hours => \$2\) ORDER BY deleted_at, id LIMIT \$3/,
    );
    expect(first?.params).toEqual([NOW.toISOString(), RETENTION_HOURS, 100]);
    expect(flat(second?.text)).toMatch(
      /AND \(deleted_at, id\) > \(\$3::timestamptz, \$4::uuid\) ORDER BY deleted_at, id LIMIT \$5/,
    );
    // The cursor keeps Postgres's own text, microseconds included.
    expect(second?.params).toEqual([
      NOW.toISOString(),
      RETENTION_HOURS,
      '2026-10-01 10:00:00.123456+00',
      idOf(7),
      50,
    ]);
  });
});

describe('the trash-purge run (AC-6)', () => {
  it('purges in batches of 100, oldest first', async () => {
    const deleted = deletedIssues(250);
    const trash = fakeTrash(deleted);
    const { executor, purged } = fakeExecutor(deleted);
    await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(DAILY_BATCH.size).toBe(100);
    expect(trash.selects).toEqual([
      { limit: 100 },
      { after: idOf(100), limit: 100 },
      { after: idOf(200), limit: 100 },
    ]);
    expect(purged).toEqual(Array.from({ length: 250 }, (_, n) => idOf(n + 1)));
  });

  it('stops at 5,000 a run; the next run takes the rest', async () => {
    const deleted = deletedIssues(5_050);
    const trash = fakeTrash(deleted);
    const { executor, purged } = fakeExecutor(deleted);
    const first = await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(DAILY_BATCH.cap).toBe(5_000);
    expect(first.done).toBe(5_000);
    expect(trash.selects).toHaveLength(50);
    const second = await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(second.done).toBe(50);
    expect(new Set(purged).size).toBe(5_050);
  });

  it('resumes after a crash without purging anything twice', async () => {
    const deleted = deletedIssues(250);
    const trash = fakeTrash(deleted);
    const { executor, purged } = fakeExecutor(deleted);
    trash.crashOnSelect(3);
    await expect(
      purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent }),
    ).rejects.toThrow('worker crashed');
    expect(purged).toHaveLength(200);
    trash.crashOnSelect(undefined);
    await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(purged).toHaveLength(250);
    expect(new Set(purged).size).toBe(250);
    expect(execCount(executor)).toBe(250);
  });

  it('counts NOT_FOUND as done, leaves a restored issue (CONFLICT), and retries a failure next run', async () => {
    const deleted = deletedIssues(4);
    const trash = fakeTrash(deleted);
    const answers = new Map([
      // Purged by an Admin after it was selected.
      [idOf(1), failure('NOT_FOUND')],
      // Restored after it was selected.
      [idOf(2), failure('CONFLICT')],
      [idOf(3), failure('INTERNAL')],
    ]);
    const { executor, purged } = fakeExecutor(deleted, (id) => answers.get(id));
    const log = { warn: vi.fn() };
    const registry = new Registry();
    const metrics = trashPurgeMetrics(registry, trash.db, () => NOW);
    const counts = await purgeTrash({ db: trash.db, executor, clock: () => NOW, log, metrics });
    expect(counts).toEqual({ done: 2, skipped: 1, failed: 1 });
    expect(purged).toEqual([idOf(4)]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ issueId: idOf(3), code: 'INTERNAL' });
    // A failed issue isn't selected again in the same run (the cursor moved past it).
    expect(execCount(executor)).toBe(4);
    const text = await registry.metrics();
    expect(text).toContain('surface_trash_purged_total 1');
    expect(text).toContain('surface_trash_purge_failures_total 1');
    // The next run tries it again.
    answers.delete(idOf(3));
    await purgeTrash({ db: trash.db, executor, clock: () => NOW, log, metrics });
    expect(purged).toContain(idOf(3));
  });

  it('counts a thrown executor error as a failure and goes on', async () => {
    const deleted = deletedIssues(2);
    const trash = fakeTrash(deleted);
    const { executor, purged } = fakeExecutor(deleted);
    executor.execute.mockImplementationOnce(() => Promise.reject(new Error('pool ended')));
    const counts = await purgeTrash({ db: trash.db, executor, clock: () => NOW, log: silent });
    expect(counts).toEqual({ done: 1, skipped: 0, failed: 1 });
    expect(purged).toEqual([idOf(2)]);
  });

  it('reports the age of the oldest deleted issue, 0 when none is deleted', async () => {
    const deleted = new Map([[idOf(1), new Date(NOW.getTime() - 40 * 24 * HOUR)]]);
    const registry = new Registry();
    trashPurgeMetrics(registry, fakeTrash(deleted).db, () => NOW);
    expect(await registry.metrics()).toContain(
      `surface_trash_oldest_deleted_age_seconds ${String(40 * 24 * 3600)}`,
    );
    deleted.clear();
    expect(await registry.metrics()).toContain('surface_trash_oldest_deleted_age_seconds 0');
  });
});

function execCount(executor: { execute: { mock: { calls: unknown[] } } }): number {
  return executor.execute.mock.calls.length;
}

/**
 * pg-boss as the daily jobs use it, with an exclusive queue: `send` with a `singletonKey` that is
 * already queued or active returns null and queues nothing. `complete` runs the queued job's
 * worker once and records it as completed at the clock's time.
 */
function fakeQueue(clock: () => Date) {
  const queued: { name: string; key: string | undefined }[] = [];
  const completed: { name: string; completedOn: Date }[] = [];
  const created: { name: string; options: unknown }[] = [];
  const scheduled: { name: string; cron: string; options: unknown }[] = [];
  const workers = new Map<string, () => Promise<unknown>>();
  const queue = {
    createQueue: vi.fn((name: string, options: unknown) => {
      created.push({ name, options });
      return Promise.resolve();
    }),
    schedule: vi.fn((name: string, cron: string, _data: unknown, options: unknown) => {
      scheduled.push({ name, cron, options });
      return Promise.resolve();
    }),
    work: vi.fn((name: string, _options: unknown, handler: () => Promise<unknown>) => {
      workers.set(name, handler);
      return Promise.resolve(`worker-${name}`);
    }),
    send: vi.fn((name: string, _data: unknown, options?: { singletonKey?: string }) => {
      const key = options?.singletonKey;
      if (key !== undefined && queued.some((job) => job.name === name && job.key === key)) {
        return Promise.resolve(null);
      }
      queued.push({ name, key });
      return Promise.resolve(`job-${String(queued.length)}`);
    }),
    findJobs: vi.fn((name: string) =>
      Promise.resolve(
        completed
          .filter((job) => job.name === name)
          .map((job) => ({ state: 'completed', completedOn: job.completedOn })),
      ),
    ),
  };
  async function complete(name: string): Promise<number> {
    const runs = queued.filter((job) => job.name === name).length;
    for (let i = queued.length - 1; i >= 0; i--) {
      if (queued[i]?.name === name) queued.splice(i, 1);
    }
    const worker = workers.get(name);
    for (let n = 0; n < runs; n++) {
      await worker?.();
      completed.push({ name, completedOn: clock() });
    }
    return runs;
  }
  return {
    queue: queue as unknown as DailyQueue,
    created,
    scheduled,
    queued,
    completed,
    complete,
  };
}

describe('scheduling and catch-up (AC-6, §6.3)', () => {
  const trash = QUEUES.trashPurge;

  it('runs daily at 03:53 UTC on an exclusive queue named by its singletonKey', async () => {
    const q = fakeQueue(() => NOW);
    const deleted = new Map<string, Date>();
    await registerDailyJob(
      q.queue,
      trashPurgeJob(trash, {
        db: fakeTrash(deleted).db,
        executor: fakeExecutor(deleted).executor,
        clock: () => NOW,
        log: silent,
      }),
      { clock: () => NOW, log: silent, pollingIntervalSeconds: 30 },
    );
    expect(trash).toEqual({ name: 'trash-purge', cron: '53 3 * * *' });
    expect(q.created).toEqual([{ name: 'trash-purge', options: { policy: 'exclusive' } }]);
    expect(q.scheduled).toEqual([
      { name: 'trash-purge', cron: '53 3 * * *', options: { singletonKey: 'trash-purge' } },
    ]);
  });

  it('a second worker starting at once doesn’t run it twice (one singletonKey)', async () => {
    let now = NOW;
    const clock = () => now;
    const q = fakeQueue(clock);
    const deleted = deletedIssues(3);
    const { executor, purged } = fakeExecutor(deleted);
    const job = trashPurgeJob(trash, { db: fakeTrash(deleted).db, executor, clock, log: silent });
    const start = () =>
      registerDailyJob(q.queue, job, { clock, log: silent, pollingIntervalSeconds: 30 });
    // Two replicas start with no completed run: both try to catch up, one job is queued.
    await Promise.all([start(), start()]);
    expect(q.queued).toEqual([{ name: 'trash-purge', key: 'trash-purge' }]);
    expect(await q.complete('trash-purge')).toBe(1);
    expect(purged).toHaveLength(3);
    // A restart within 24 h of that run doesn't catch up again.
    now = new Date(NOW.getTime() + HOUR);
    await start();
    expect(q.queued).toEqual([]);
  });

  it('catches up when the last completed run is more than 24 h old, or there is none', async () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const q = fakeQueue(() => NOW);
    expect(await catchUp(q.queue, 'trash-purge', NOW)).toBe(true);
    await q.complete('trash-purge');
    expect(await catchUp(q.queue, 'trash-purge', at(CATCH_UP_AFTER_MS))).toBe(false);
    expect(await catchUp(q.queue, 'trash-purge', at(CATCH_UP_AFTER_MS + 1))).toBe(true);
    expect(q.queued).toEqual([{ name: 'trash-purge', key: 'trash-purge' }]);
  });
});
