// PLAN-015 S3, SPEC-015 §6.3: AC-7 (the `auto-archive` job selects exactly the live, closed issues
// where `greatest(completedAt, canceledAt, updatedAt) + N months <= now`, N from the issue's
// team, exact boundary; skips open, archived and deleted issues; leaves a just-restored issue
// alone; writes the `archived` entry once as the system actor; stops at 5,000 a run; a second
// start with the same `singletonKey` doesn't run it twice), E19 (a lowered period drains 5,000 a
// run) and E20 (a restored issue waits a full period). A fake clock, executor, queue and
// selection; the selection's SQL is checked as text, the operation's rules run on the in-memory
// workspace.
import { addMonthsUtc, autoArchiveDueAt, CLOSED_CATEGORIES, type Actor } from '@surface/domain';
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import { SurfaceError } from '../src/executor/errors.js';
import type { ExecuteResult } from '../src/executor/execute.js';
import { autoArchiveIssue } from '../src/handlers/issues/auto-core.js';
import {
  autoArchive,
  autoArchiveJob,
  autoArchiveMetrics,
  pgAutoArchiveDb,
  type AutoArchiveDb,
  type AutoArchiveItem,
} from '../src/jobs/auto-archive.js';
import { DAILY_BATCH, registerDailyJob, type DailyQueue } from '../src/jobs/daily-batch.js';
import { QUEUES } from '../src/jobs/index.js';
import { memoryAuto, seedIssue } from './support/memory-auto.js';
import { memoryIssues } from './support/memory-issues.js';
import type { Statement } from './support/scripted-db.js';

const NOW = new Date('2026-11-16T03:29:00.000Z');
const idOf = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const silent = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

interface FakeIssue {
  readonly id: string;
  readonly category: 'completed' | 'canceled' | 'duplicate' | 'started' | 'backlog';
  readonly completedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly updatedAt: Date;
  readonly months: number;
  readonly archived?: boolean;
  readonly deleted?: boolean;
}

/** The selection over fake issues, with §6.3's rule written through the domain's. */
function fakeSelection(issues: Map<string, FakeIssue>) {
  const selects: { after?: string; limit: number }[] = [];
  const at = (i: FakeIssue) =>
    Math.max(
      ...[i.completedAt, i.canceledAt, i.updatedAt].flatMap((d) => (d ? [d.getTime()] : [])),
    );
  const db: AutoArchiveDb = {
    due(now, after, limit) {
      selects.push({ ...(after ? { after: after.id } : {}), limit });
      const due = [...issues.values()]
        .filter(
          (i) =>
            i.archived !== true &&
            i.deleted !== true &&
            CLOSED_CATEGORIES.has(i.category) &&
            autoArchiveDueAt(i, i.months).getTime() <= now.getTime(),
        )
        .map((i): AutoArchiveItem => ({ id: i.id, at: new Date(at(i)).toISOString() }))
        .sort((a, b) => `${a.at}|${a.id}`.localeCompare(`${b.at}|${b.id}`))
        .filter((i) => after === undefined || `${i.at}|${i.id}` > `${after.at}|${after.id}`);
      return Promise.resolve(due.slice(0, limit));
    },
  };
  return { db, selects };
}

function fakeExecutor(
  issues: Map<string, FakeIssue>,
  answer: (id: string) => ExecuteResult | undefined = () => undefined,
) {
  const archived: string[] = [];
  const actors: Actor[] = [];
  const execute = vi.fn((op: string, input: unknown, actor: Actor): Promise<ExecuteResult> => {
    actors.push(actor);
    const id = String(Reflect.get(Object(input), 'issue'));
    if (op !== 'issue.autoArchive') throw new Error(`unexpected ${op}`);
    const scripted = answer(id);
    if (scripted !== undefined) return Promise.resolve(scripted);
    const issue = issues.get(id);
    if (!issue) return Promise.resolve(failure('NOT_FOUND'));
    issues.set(id, { ...issue, archived: true });
    archived.push(id);
    return Promise.resolve({ ok: true, result: { id } });
  });
  return { executor: { execute }, archived, actors };
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'): ExecuteResult {
  return { ok: false, error: { code, message: code, correlationId: 'c-1' } };
}

const closedAt = (months: number, plusMs = 0) =>
  new Date(addMonthsUtc(NOW, -months).getTime() + plusMs);

function closed(n: number, over: Partial<FakeIssue> = {}): FakeIssue {
  const at = closedAt(6);
  return {
    id: idOf(n),
    category: 'completed',
    completedAt: at,
    canceledAt: null,
    updatedAt: at,
    months: 6,
    ...over,
  };
}

describe('the auto-archive selection (AC-7)', () => {
  it('archives a closed issue at exactly closedAt + N months and not 1 ms before', async () => {
    const issues = new Map(
      [closed(1), closed(2, { completedAt: closedAt(6, 1), updatedAt: closedAt(6, 1) })].map(
        (i) => [i.id, i],
      ),
    );
    const { executor, archived, actors } = fakeExecutor(issues);
    const counts = await autoArchive({
      db: fakeSelection(issues).db,
      executor,
      clock: () => NOW,
      log: silent,
    });
    expect(archived).toEqual([idOf(1)]);
    expect(counts).toEqual({ done: 1, skipped: 0, failed: 0 });
    // Through the executor, as the system actor (§6.3).
    expect(actors.map((a) => a.kind)).toEqual(['system']);
  });

  it('uses the issue’s own team period', async () => {
    const issues = new Map(
      [closed(1, { months: 12 }), closed(2, { months: 3 })].map((i) => [i.id, i]),
    );
    const { executor, archived } = fakeExecutor(issues);
    await autoArchive({ db: fakeSelection(issues).db, executor, clock: () => NOW, log: silent });
    // Both closed 6 months ago: due under 3 months, not under 12.
    expect(archived).toEqual([idOf(2)]);
  });

  it('counts a Canceled or Duplicate issue as closed and leaves open, archived and deleted ones', async () => {
    const issues = new Map(
      [
        closed(1, { category: 'canceled', completedAt: null, canceledAt: closedAt(6) }),
        closed(2, { category: 'duplicate', completedAt: null, canceledAt: closedAt(6) }),
        closed(3, { category: 'started' }),
        closed(4, { category: 'backlog' }),
        closed(5, { archived: true }),
        closed(6, { deleted: true }),
      ].map((i) => [i.id, i]),
    );
    const { executor, archived } = fakeExecutor(issues);
    await autoArchive({ db: fakeSelection(issues).db, executor, clock: () => NOW, log: silent });
    expect(archived).toEqual([idOf(1), idOf(2)]);
  });

  it('waits a full period after a later edit or restore: updatedAt counts (E20)', async () => {
    // Closed a year ago, restored (updatedAt moves) yesterday.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const issues = new Map(
      [closed(1, { completedAt: closedAt(12), updatedAt: yesterday })].map((i) => [i.id, i]),
    );
    const { executor, archived } = fakeExecutor(issues);
    await autoArchive({ db: fakeSelection(issues).db, executor, clock: () => NOW, log: silent });
    expect(archived).toEqual([]);
  });

  it('selects in Postgres: live closed issues, the team’s months in UTC, oldest first, after the cursor', async () => {
    const statements: Statement[] = [];
    const pool = {
      query(config: { text: string }, params: unknown[] = []) {
        statements.push({ text: config.text, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db = pgAutoArchiveDb(pool as unknown as Pool);
    await db.due(NOW, undefined, 100);
    await db.due(NOW, { id: idOf(7), at: '2026-05-16 03:00:00.123456+00' }, 50);
    const flat = (text = '') => text.replace(/\s+/g, ' ');
    const [first, second] = statements;
    expect(flat(first?.text)).toMatch(/i\.archived_at IS NULL AND i\.deleted_at IS NULL/);
    expect(flat(first?.text)).toMatch(/s\.category IN \('completed', 'canceled', 'duplicate'\)/);
    expect(flat(first?.text)).toMatch(
      /\(greatest\(i\.completed_at, i\.canceled_at, i\.updated_at\) AT TIME ZONE 'UTC'\) \+ make_interval\(months => t\.auto_archive_months\)\) AT TIME ZONE 'UTC' <= \$1::timestamptz/,
    );
    expect(flat(first?.text)).toMatch(
      /ORDER BY greatest\(i\.completed_at, i\.canceled_at, i\.updated_at\), i\.id LIMIT \$2/,
    );
    expect(first?.params).toEqual([NOW.toISOString(), 100]);
    expect(flat(second?.text)).toMatch(
      /AND \(greatest\(.*\), i\.id\) > \(\$2::timestamptz, \$3::uuid\)/,
    );
    expect(second?.params).toEqual([
      NOW.toISOString(),
      '2026-05-16 03:00:00.123456+00',
      idOf(7),
      50,
    ]);
  });
});

describe('the auto-archive run (AC-7, E19)', () => {
  const many = (count: number, months = 1) =>
    new Map(
      Array.from({ length: count }, (_, n) => {
        // One minute apart, oldest first.
        const at = new Date(closedAt(months).getTime() - (count - n) * 60_000);
        return [idOf(n + 1), closed(n + 1, { completedAt: at, updatedAt: at, months })] as const;
      }),
    );

  it('archives in batches of 100, and stops at 5,000 a run; the next run takes the rest (E19)', async () => {
    // A team lowered from 12 months to 1: everything closed 1 month ago is due at once.
    const issues = many(5_050);
    const selection = fakeSelection(issues);
    const { executor, archived } = fakeExecutor(issues);
    const first = await autoArchive({ db: selection.db, executor, clock: () => NOW, log: silent });
    expect(DAILY_BATCH).toEqual({ size: 100, cap: 5_000 });
    expect(first.done).toBe(5_000);
    expect(selection.selects).toHaveLength(50);
    expect(selection.selects[0]).toEqual({ limit: 100 });
    expect(selection.selects[1]).toEqual({ after: idOf(100), limit: 100 });
    const second = await autoArchive({ db: selection.db, executor, clock: () => NOW, log: silent });
    expect(second.done).toBe(50);
    expect(new Set(archived).size).toBe(5_050);
  });

  it('counts CONFLICT and NOT_FOUND as skipped, other errors as failed, and keeps going', async () => {
    const issues = many(4);
    const { executor, archived } = fakeExecutor(issues, (id) =>
      id === idOf(1)
        ? failure('CONFLICT')
        : id === idOf(2)
          ? failure('NOT_FOUND')
          : id === idOf(3)
            ? failure('INTERNAL')
            : undefined,
    );
    const registry = new Registry();
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const counts = await autoArchive({
      db: fakeSelection(issues).db,
      executor,
      clock: () => NOW,
      log,
      metrics: autoArchiveMetrics(registry),
    });
    expect(counts).toEqual({ done: 1, skipped: 2, failed: 1 });
    expect(archived).toEqual([idOf(4)]);
    // The failure is logged with the issue id and its code, never more.
    expect(log.warn).toHaveBeenCalledWith(
      { issueId: idOf(3), code: 'INTERNAL' },
      'auto-archive could not change an issue',
    );
    const text = await registry.metrics();
    expect(text).toMatch(/surface_auto_archived_total 1/);
    expect(text).toMatch(/surface_auto_archive_failures_total 1/);
  });

  it('counts a throw as a failure and logs it without the error text of a secret', async () => {
    const issues = many(1);
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const counts = await autoArchive({
      db: fakeSelection(issues).db,
      executor: { execute: () => Promise.reject(new Error('pool closed')) },
      clock: () => NOW,
      log,
    });
    expect(counts.failed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: idOf(1) }),
      'auto-archive failed on an issue',
    );
  });

  it('stops before the next issue once the job’s signal aborts', async () => {
    const issues = many(10);
    const controller = new AbortController();
    const { executor, archived } = fakeExecutor(issues, (id) => {
      if (id === idOf(3)) controller.abort();
      return undefined;
    });
    const counts = await autoArchive({
      db: fakeSelection(issues).db,
      executor,
      clock: () => NOW,
      log: silent,
      signal: controller.signal,
    });
    // The third was already running when the signal aborted: it finishes, the fourth never starts.
    expect(counts.done).toBe(3);
    expect(archived).toEqual([idOf(1), idOf(2), idOf(3)]);
  });
});

describe('the auto-archive schedule (AC-7)', () => {
  function fakeQueue() {
    const sent: { name: string; options: unknown }[] = [];
    const schedules: unknown[][] = [];
    const queues: unknown[][] = [];
    const queue = {
      createQueue: (...args: unknown[]) => {
        queues.push(args);
        return Promise.resolve();
      },
      schedule: (...args: unknown[]) => {
        schedules.push(args);
        return Promise.resolve();
      },
      work: () => Promise.resolve('worker'),
      send: (name: string, _data: unknown, options: unknown) => {
        sent.push({ name, options });
        return Promise.resolve('job');
      },
      findJobs: () => Promise.resolve([]),
    };
    return { queue: queue as unknown as DailyQueue, sent, schedules, queues };
  }

  it('runs daily at 03:29 UTC on an exclusive queue and catches up once with its singletonKey', async () => {
    expect(QUEUES.autoArchive).toMatchObject({ name: 'auto-archive', cron: '29 3 * * *' });
    const { queue, sent, schedules, queues } = fakeQueue();
    const job = autoArchiveJob(QUEUES.autoArchive, {
      db: fakeSelection(new Map()).db,
      executor: { execute: () => Promise.reject(new Error('unused')) },
      clock: () => NOW,
      log: silent,
    });
    const options = { clock: () => NOW, log: silent, pollingIntervalSeconds: 1 };
    // Two workers starting together send two runs with one key: the exclusive queue keeps one.
    await Promise.all([
      registerDailyJob(queue, job, options),
      registerDailyJob(queue, job, options),
    ]);
    expect(queues[0]).toEqual(['auto-archive', expect.objectContaining({ policy: 'exclusive' })]);
    expect(schedules[0]).toEqual([
      'auto-archive',
      '29 3 * * *',
      null,
      { singletonKey: 'auto-archive' },
    ]);
    expect(sent).toEqual([
      { name: 'auto-archive', options: { singletonKey: 'auto-archive' } },
      { name: 'auto-archive', options: { singletonKey: 'auto-archive' } },
    ]);
  });
});

describe('issue.autoArchive on one issue (AC-7, E20)', () => {
  const EARLIER = new Date('2026-05-01T00:00:00.000Z');

  it('archives a due issue once: an A write, the archived entry, the issue.archived event', async () => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Done', completedAt: EARLIER, updatedAt: EARLIER });
    const auto = memoryAuto(m);
    const row = await autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
    expect(row.archivedAt).not.toBeNull();
    // The archive, then the history entry's insert (PLAN-011 S6's writer).
    expect(m.writes.map((w) => [w.action, w.model ?? 'Issue'])).toEqual([
      ['archive', 'Issue'],
      ['insert', 'IssueHistory'],
    ]);
    // The history seam runs exactly once, with the `archived` kind (§4.8).
    expect(auto.archivedHistory).toEqual([issue.id]);
    expect(m.history).toEqual([{ kind: 'archived', issueId: issue.id }]);
    // The entry it writes: actor system, empty changes, never folded into `created` (SPEC-011 §4.4).
    expect(m.historyRows.filter((r) => r.issueId === issue.id).map((r) => r.kind)).toEqual([
      'created',
      'archived',
    ]);
    expect(m.historyRows.at(-1)).toMatchObject({
      kind: 'archived',
      actorKind: 'system',
      actorId: null,
      apiKeyId: null,
      changes: {},
    });
    expect(m.events).toEqual([
      {
        type: 'issue.archived',
        subject: { type: 'issue', id: issue.id },
        data: { teamId: issue.teamId, number: issue.number },
      },
    ]);
    // Team row, then the issue lock, in `lifecycle` mode (SPEC-011 §4.8, the table).
    expect(m.calls.slice(0, 2)).toEqual(['shareTeam', 'lockIssue']);
    expect(m.lockModes).toEqual(['lifecycle']);
  });

  it('leaves a restored issue alone: its fresh updatedAt starts a full period (E20)', async () => {
    const m = memoryIssues();
    const justRestored = new Date(NOW.getTime() - 1000);
    const issue = await seedIssue(m, {
      status: 'Done',
      completedAt: EARLIER,
      updatedAt: justRestored,
    });
    const auto = memoryAuto(m);
    await expect(
      autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'ENG-1 is not due to be archived.' });
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
    expect(auto.archivedHistory).toEqual([]);
  });

  it.each([
    ['an open one', { status: 'Backlog' }],
    ['one reopened after selection', { status: 'In Progress' }],
  ])('skips %s with no write, entry or event', async (_, fields) => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { ...fields, completedAt: EARLIER, updatedAt: EARLIER });
    const auto = memoryAuto(m);
    await expect(
      autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
    ).rejects.toBeInstanceOf(SurfaceError);
    expect([m.writes, m.events, auto.archivedHistory]).toEqual([[], [], []]);
  });

  it.each([
    ['archived', { archivedAt: EARLIER }, 'is no longer live'],
    ['deleted', { deletedAt: EARLIER, deletedById: null }, 'is no longer live'],
  ])(
    'skips an issue already %s, so a second run archives nothing twice',
    async (_, state, text) => {
      const m = memoryIssues();
      const issue = await seedIssue(m, {
        status: 'Done',
        completedAt: EARLIER,
        updatedAt: EARLIER,
        ...state,
      });
      const auto = memoryAuto(m);
      await expect(
        autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining(text) as string,
      });
      expect([m.writes, m.events, auto.archivedHistory]).toEqual([[], [], []]);
    },
  );

  it('re-reads the team’s period under its lock: a period raised after selection skips the issue', async () => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Done', completedAt: EARLIER, updatedAt: EARLIER });
    const auto = memoryAuto(m, { settings: { autoArchiveMonths: 12 } });
    await expect(
      autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(m.writes).toEqual([]);
  });

  it('archives exactly at the boundary and not 1 ms before it', async () => {
    const due = addMonthsUtc(EARLIER, 6);
    for (const [now, archives] of [
      [due, true],
      [new Date(due.getTime() - 1), false],
    ] as const) {
      const m = memoryIssues();
      const issue = await seedIssue(m, {
        status: 'Done',
        completedAt: EARLIER,
        updatedAt: EARLIER,
      });
      const auto = memoryAuto(m, { now });
      const run = autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
      if (archives) await expect(run).resolves.toMatchObject({ id: issue.id });
      else await expect(run).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });
});

describe('addMonthsUtc', () => {
  it('clamps to the end of a shorter month like Postgres, keeping the time of day', () => {
    expect(addMonthsUtc(new Date('2026-08-31T10:20:30.456Z'), 6).toISOString()).toBe(
      '2027-02-28T10:20:30.456Z',
    );
    expect(addMonthsUtc(new Date('2028-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(addMonthsUtc(new Date('2026-11-16T03:29:00.000Z'), -6).toISOString()).toBe(
      '2026-05-16T03:29:00.000Z',
    );
    expect(addMonthsUtc(new Date('2026-12-15T00:00:00.000Z'), 12).toISOString()).toBe(
      '2027-12-15T00:00:00.000Z',
    );
  });
});
