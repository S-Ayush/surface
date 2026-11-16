// PLAN-015 S3, SPEC-015 §6.3: AC-8 (the `auto-close` job selects exactly the live Backlog,
// Unstarted and Started issues with `updatedAt + N months <= now` in teams with auto-close on;
// moves them to the team's auto-close status with the SPEC-011 §4.6 category side effects and a
// system `updated` entry; skips a team with no auto-close status; skips issues that stopped being
// stale after the lock) and E21 (an edit that lands first leaves nothing for the job). A fake
// clock, executor and selection; the selection's SQL is checked as text, the operation's rules
// run on the in-memory workspace.
import { randomUUID } from 'node:crypto';
import { addMonthsUtc, autoCloseDueAt, type Actor } from '@surface/domain';
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import type { ExecuteResult } from '../src/executor/execute.js';
import { autoCloseIssue } from '../src/handlers/issues/auto-core.js';
import {
  autoClose,
  autoCloseJob,
  autoCloseMetrics,
  pgAutoCloseDb,
  type AutoCloseDb,
  type AutoCloseItem,
} from '../src/jobs/auto-close.js';
import { registerDailyJob, type DailyQueue } from '../src/jobs/daily-batch.js';
import { QUEUES } from '../src/jobs/index.js';
import { memoryAuto, seedIssue } from './support/memory-auto.js';
import { memoryIssues } from './support/memory-issues.js';
import type { Statement } from './support/scripted-db.js';

const NOW = new Date('2026-11-16T03:17:00.000Z');
const idOf = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const silent = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

interface FakeIssue {
  readonly id: string;
  readonly category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
  readonly updatedAt: Date;
  /** The team's auto-close months, or null while it is off. */
  readonly months: number | null;
  readonly hasStatus?: boolean;
  readonly archived?: boolean;
  readonly deleted?: boolean;
}

/** The selection over fake issues, with §6.3's rule written through the domain's. */
function fakeSelection(issues: Map<string, FakeIssue>) {
  const selects: { after?: string; limit: number }[] = [];
  const db: AutoCloseDb = {
    due(now, after, limit) {
      selects.push({ ...(after ? { after: after.id } : {}), limit });
      const due = [...issues.values()]
        .filter(
          (i) =>
            i.archived !== true &&
            i.deleted !== true &&
            ['backlog', 'unstarted', 'started'].includes(i.category) &&
            i.months !== null &&
            i.hasStatus !== false &&
            autoCloseDueAt(i, i.months).getTime() <= now.getTime(),
        )
        .map((i): AutoCloseItem => ({ id: i.id, at: i.updatedAt.toISOString() }))
        .sort((a, b) => `${a.at}|${a.id}`.localeCompare(`${b.at}|${b.id}`))
        .filter((i) => after === undefined || `${i.at}|${i.id}` > `${after.at}|${after.id}`);
      return Promise.resolve(due.slice(0, limit));
    },
  };
  return { db, selects };
}

function fakeExecutor(answer: (id: string) => ExecuteResult | undefined = () => undefined) {
  const closed: string[] = [];
  const actors: Actor[] = [];
  const execute = vi.fn((op: string, input: unknown, actor: Actor): Promise<ExecuteResult> => {
    actors.push(actor);
    const id = String(Reflect.get(Object(input), 'issue'));
    if (op !== 'issue.autoClose') throw new Error(`unexpected ${op}`);
    const scripted = answer(id);
    if (scripted !== undefined) return Promise.resolve(scripted);
    closed.push(id);
    return Promise.resolve({ ok: true, result: { id } });
  });
  return { executor: { execute }, closed, actors };
}

function failure(code: 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'): ExecuteResult {
  return { ok: false, error: { code, message: code, correlationId: 'c-1' } };
}

const staleSince = (months: number, plusMs = 0) =>
  new Date(addMonthsUtc(NOW, -months).getTime() + plusMs);

function stale(n: number, over: Partial<FakeIssue> = {}): FakeIssue {
  return { id: idOf(n), category: 'started', updatedAt: staleSince(6), months: 6, ...over };
}

const byId = (issues: FakeIssue[]) => new Map(issues.map((i) => [i.id, i]));

describe('the auto-close selection (AC-8)', () => {
  it('closes at exactly updatedAt + N months and not 1 ms before', async () => {
    const issues = byId([stale(1), stale(2, { updatedAt: staleSince(6, 1) })]);
    const { executor, closed, actors } = fakeExecutor();
    const counts = await autoClose({
      db: fakeSelection(issues).db,
      executor,
      clock: () => NOW,
      log: silent,
    });
    expect(closed).toEqual([idOf(1)]);
    expect(counts).toEqual({ done: 1, skipped: 0, failed: 0 });
    expect(actors.map((a) => a.kind)).toEqual(['system']);
  });

  it('takes Backlog, Unstarted and Started issues of teams with auto-close on, and nothing else', async () => {
    const issues = byId([
      stale(1, { category: 'backlog' }),
      stale(2, { category: 'unstarted' }),
      stale(3, { category: 'started' }),
      stale(4, { category: 'completed' }),
      stale(5, { category: 'canceled' }),
      stale(6, { months: null }),
      stale(7, { hasStatus: false }),
      stale(8, { archived: true }),
      stale(9, { deleted: true }),
    ]);
    const { executor, closed } = fakeExecutor();
    await autoClose({ db: fakeSelection(issues).db, executor, clock: () => NOW, log: silent });
    expect(closed).toEqual([idOf(1), idOf(2), idOf(3)]);
  });

  it('uses each team’s own period', async () => {
    const issues = byId([stale(1, { months: 12 }), stale(2, { months: 3 })]);
    const { executor, closed } = fakeExecutor();
    await autoClose({ db: fakeSelection(issues).db, executor, clock: () => NOW, log: silent });
    expect(closed).toEqual([idOf(2)]);
  });

  it('selects in Postgres: live open issues of teams with a status, the months in UTC, oldest first, after the cursor', async () => {
    const statements: Statement[] = [];
    const pool = {
      query(config: { text: string }, params: unknown[] = []) {
        statements.push({ text: config.text, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db = pgAutoCloseDb(pool as unknown as Pool);
    await db.due(NOW, undefined, 100);
    await db.due(NOW, { id: idOf(7), at: '2026-05-16 03:00:00.123456+00' }, 50);
    const flat = (text = '') => text.replace(/\s+/g, ' ');
    const [first, second] = statements;
    expect(flat(first?.text)).toMatch(/s\.category IN \('backlog', 'unstarted', 'started'\)/);
    expect(flat(first?.text)).toMatch(
      /t\.auto_close_months IS NOT NULL AND t\.auto_close_status_id IS NOT NULL/,
    );
    expect(flat(first?.text)).toMatch(
      /\(i\.updated_at AT TIME ZONE 'UTC'\) \+ make_interval\(months => t\.auto_close_months\)\) AT TIME ZONE 'UTC' <= \$1::timestamptz ORDER BY i\.updated_at, i\.id LIMIT \$2/,
    );
    expect(first?.params).toEqual([NOW.toISOString(), 100]);
    expect(flat(second?.text)).toMatch(
      /AND \(i\.updated_at, i\.id\) > \(\$2::timestamptz, \$3::uuid\)/,
    );
    expect(second?.params).toEqual([
      NOW.toISOString(),
      '2026-05-16 03:00:00.123456+00',
      idOf(7),
      50,
    ]);
  });

  it('counts CONFLICT (no longer stale, E21) as skipped, other errors as failed, with counters', async () => {
    const issues = byId([stale(1), stale(2), stale(3)]);
    const { executor, closed } = fakeExecutor((id) =>
      id === idOf(1) ? failure('CONFLICT') : id === idOf(2) ? failure('INTERNAL') : undefined,
    );
    const registry = new Registry();
    const counts = await autoClose({
      db: fakeSelection(issues).db,
      executor,
      clock: () => NOW,
      log: silent,
      metrics: autoCloseMetrics(registry),
    });
    expect(counts).toEqual({ done: 1, skipped: 1, failed: 1 });
    expect(closed).toEqual([idOf(3)]);
    const text = await registry.metrics();
    expect(text).toMatch(/surface_auto_closed_total 1/);
    expect(text).toMatch(/surface_auto_close_failures_total 1/);
  });

  it('runs daily at 03:17 UTC on an exclusive queue with a singletonKey catch-up', async () => {
    expect(QUEUES.autoClose).toMatchObject({ name: 'auto-close', cron: '17 3 * * *' });
    const sent: unknown[] = [];
    const schedules: unknown[][] = [];
    const queue = {
      createQueue: () => Promise.resolve(),
      schedule: (...args: unknown[]) => {
        schedules.push(args);
        return Promise.resolve();
      },
      work: () => Promise.resolve('worker'),
      send: (name: string, _data: unknown, options: unknown) => {
        sent.push([name, options]);
        return Promise.resolve('job');
      },
      findJobs: () => Promise.resolve([]),
    } as unknown as DailyQueue;
    await registerDailyJob(
      queue,
      autoCloseJob(QUEUES.autoClose, {
        db: fakeSelection(new Map()).db,
        executor: { execute: () => Promise.reject(new Error('unused')) },
        clock: () => NOW,
        log: silent,
      }),
      { clock: () => NOW, log: silent, pollingIntervalSeconds: 1 },
    );
    expect(schedules[0]).toEqual([
      'auto-close',
      '17 3 * * *',
      null,
      { singletonKey: 'auto-close' },
    ]);
    expect(sent).toEqual([['auto-close', { singletonKey: 'auto-close' }]]);
  });
});

describe('issue.autoClose on one issue (AC-8, E21)', () => {
  const EARLIER = new Date('2026-05-01T00:00:00.000Z');

  it('moves a stale Started issue to Canceled: canceledAt set, startedAt kept, one entry, one event', async () => {
    const m = memoryIssues();
    const startedAt = new Date('2026-04-01T00:00:00.000Z');
    const issue = await seedIssue(m, { status: 'In Progress', startedAt, updatedAt: EARLIER });
    const auto = memoryAuto(m);
    const row = await autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
    const canceled = m.status(m.eng, 'Canceled');
    expect(row.statusId).toBe(canceled.id);
    // SPEC-011 §4.6: Canceled sets canceledAt, clears completedAt, keeps the first start.
    expect(row.canceledAt).toEqual(NOW_FOR(m));
    expect(row.completedAt).toBeNull();
    expect(row.startedAt).toEqual(startedAt);
    // The issue's update, then the history entry's insert (PLAN-011 S6's writer).
    expect(m.writes).toHaveLength(2);
    expect(m.writes[0]).toMatchObject({ action: 'update', fields: ['statusId', 'canceledAt'] });
    expect(m.writes[1]).toMatchObject({ action: 'insert', model: 'IssueHistory' });
    const changes = { statusId: { from: issue.statusId, to: canceled.id } };
    // The history seam runs once with the status change; the event carries the same change set.
    expect(auto.closeHistory).toEqual([{ issueId: issue.id, changes }]);
    // The entry: `updated`, actor system, the statuses' names snapshotted, not folded into the
    // creator's `created` entry ("Issue was automatically closed", SPEC-015 §4.8).
    expect(m.historyRows.filter((r) => r.issueId === issue.id).map((r) => r.kind)).toEqual([
      'created',
      'updated',
    ]);
    expect(m.historyRows.at(-1)).toMatchObject({
      actorKind: 'system',
      actorId: null,
      changes: {
        status: {
          from: { id: issue.statusId, name: 'In Progress', category: 'started' },
          to: { id: canceled.id, name: 'Canceled', category: 'canceled' },
        },
      },
    });
    expect(m.events).toEqual([
      { type: 'issue.updated', subject: { type: 'issue', id: issue.id }, changes },
    ]);
    expect(m.calls.slice(0, 3)).toEqual(['shareTeam', 'shareStatus', 'lockIssue']);
    expect(m.lockModes).toEqual(['lifecycle']);
  });

  it('closes a stale Backlog issue the same way, with no startedAt', async () => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER });
    const auto = memoryAuto(m);
    const row = await autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
    expect(row.startedAt).toBeNull();
    expect(row.canceledAt).not.toBeNull();
  });

  it('uses the team’s chosen Canceled status, not the first', async () => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER });
    const auto = memoryAuto(m);
    // The team has a second Canceled status, and chose it.
    const other = {
      id: randomUUID(),
      teamId: m.eng.id,
      name: 'Won’t do',
      category: 'canceled',
    } as const;
    m.statuses.set(other.id, other);
    auto.setSettings(m.eng.id, { autoCloseStatusId: other.id });
    const row = await autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
    expect(row.statusId).toBe(other.id);
  });

  it('skips a team with auto-close off or no auto-close status, writing nothing', async () => {
    for (const settings of [{ autoCloseMonths: null }, { autoCloseStatusId: null }]) {
      const m = memoryIssues();
      const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER });
      const auto = memoryAuto(m, { settings });
      await expect(
        autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Auto-close is off for this team.' });
      expect([m.writes, m.events, auto.closeHistory]).toEqual([[], [], []]);
    }
  });

  it('skips an issue an edit made fresh after selection: the re-check under the lock (E21)', async () => {
    const m = memoryIssues();
    // Selected as stale, then the user's edit landed first and moved updatedAt.
    const issue = await seedIssue(m, {
      status: 'Backlog',
      updatedAt: new Date(NOW_FOR(m).getTime() - 60_000),
    });
    const auto = memoryAuto(m);
    await expect(
      autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'ENG-1 is not stale.' });
    expect([m.writes, m.events, auto.closeHistory]).toEqual([[], [], []]);
  });

  it.each([
    ['closed meanwhile', { status: 'Done', completedAt: EARLIER }],
    ['archived', { archivedAt: EARLIER }],
    ['deleted', { deletedAt: EARLIER, deletedById: null }],
  ])('skips an issue %s after selection', async (_, fields) => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER, ...fields });
    const auto = memoryAuto(m);
    await expect(
      autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect([m.writes, m.events, auto.closeHistory]).toEqual([[], [], []]);
  });

  it('refuses a status that is not a Canceled one of the team, writing nothing', async () => {
    const m = memoryIssues();
    const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER });
    for (const bad of [m.status(m.eng, 'Done').id, m.status(m.des, 'Canceled').id]) {
      const auto = memoryAuto(m, { settings: { autoCloseStatusId: bad } });
      await expect(
        autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect(m.writes).toEqual([]);
  });

  it('closes exactly at the boundary and not 1 ms before it', async () => {
    const due = addMonthsUtc(EARLIER, 6);
    for (const [now, closes] of [
      [due, true],
      [new Date(due.getTime() - 1), false],
    ] as const) {
      const m = memoryIssues();
      const issue = await seedIssue(m, { status: 'Backlog', updatedAt: EARLIER });
      const auto = memoryAuto(m, { now });
      const run = autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
      if (closes) await expect(run).resolves.toMatchObject({ id: issue.id });
      else await expect(run).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });
});

/** The memory workspace's clock: `memoryAuto` defaults to it. */
function NOW_FOR(m: ReturnType<typeof memoryIssues>): Date {
  return m.ctx.now;
}
