// PLAN-010 S5, SPEC-010 §4.4 and AC-19's label race (AC-10 with real issue shapes), and E16's
// status half: `label.delete` and `status.delete` raced with `issue.update`s on a model of
// Postgres row locks (READ COMMITTED: writes show at commit, a lock waits for a conflicting holder
// until it commits). A fast-check scheduler picks which transaction moves at every read and lock.
// The rules are the real ones (`deleteLabel`, `deleteStatus`, `updateIssue`); the accesses below
// give them the lock modes their Postgres accesses take:
// - `label.delete`: team row FOR UPDATE → label row FOR UPDATE → the issues carrying the label,
//   FOR UPDATE in ascending id (a row waited for is checked again, so one that lost the label
//   meanwhile is skipped), `array_remove` computed per row.
// - `status.delete`: team row FOR UPDATE → status row FOR UPDATE → the issue count (no lock).
// - `issue.update`: FOR KEY SHARE on a new status and newly added labels → the issue FOR UPDATE.
// Label race, whatever the interleaving: nothing deadlocks (a wait-for cycle fails the run), the
// delete commits, an edit adding the label either commits first (and the cascade rewrites its
// issue) or fails with "That label was deleted. Choose another label.", a concurrent edit of
// another label on an issue the cascade rewrites keeps its label, and no issue references the
// deleted label. Status race: the edit into the status commits first and the delete is refused
// for its issue, or the delete commits and the edit is CONFLICT; never both.
import { randomUUID } from 'node:crypto';
import {
  countStatusIssues,
  lifecycleOf,
  lifecycleRefusal,
  lockRefusal,
  type IssueLockMode,
} from '@surface/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  LABEL_GONE,
  STATUS_GONE,
  updateIssue,
  type IssueAccess,
  type IssueRow,
  type LabelRow,
} from '../src/handlers/issues/core.js';
import { deleteLabel, type LabelAccess } from '../src/handlers/labels/core.js';
import {
  deleteStatus,
  type StatusRow,
  type WorkflowAccess,
} from '../src/handlers/statuses/core.js';
import type { Repo } from '../src/sync/repo.js';
import { memoryIssues, NOW } from './support/memory-issues.js';

type Mode = 'keyShare' | 'update';

class Deadlock extends Error {}

/** Row locks as Postgres takes them for these modes: FOR UPDATE conflicts with everything. */
class Locks {
  readonly #held = new Map<string, Map<number, Mode>>();
  readonly #waiting = new Map<number, string>();
  readonly #wakers = new Set<() => void>();

  #blockers(tx: number, row: string, mode: Mode): number[] {
    const holders = this.#held.get(row) ?? new Map<number, Mode>();
    return [...holders].flatMap(([other, held]) =>
      other !== tx && (mode === 'update' || held === 'update') ? [other] : [],
    );
  }

  /** Whether `from` waits, directly or through others, on `to`. */
  #reaches(from: number, to: number, seen = new Set<number>()): boolean {
    const row = this.#waiting.get(from);
    if (row === undefined || seen.has(from)) return false;
    seen.add(from);
    const holders = [...(this.#held.get(row)?.keys() ?? [])].filter((h) => h !== from);
    return holders.some((h) => h === to || this.#reaches(h, to, seen));
  }

  async acquire(tx: number, row: string, mode: Mode): Promise<void> {
    for (;;) {
      const blockers = this.#blockers(tx, row, mode);
      if (blockers.length === 0) break;
      this.#waiting.set(tx, row);
      if (blockers.some((b) => b === tx || this.#reaches(b, tx))) {
        this.#waiting.delete(tx);
        throw new Deadlock(`deadlock: tx ${tx} waits for ${row}`);
      }
      await new Promise<void>((resolve) => this.#wakers.add(resolve));
    }
    this.#waiting.delete(tx);
    const holders = this.#held.get(row) ?? new Map<number, Mode>();
    if (holders.get(tx) !== 'update') holders.set(tx, mode);
    this.#held.set(row, holders);
  }

  release(tx: number): void {
    for (const holders of this.#held.values()) holders.delete(tx);
    const wakers = [...this.#wakers];
    this.#wakers.clear();
    for (const wake of wakers) wake();
  }
}

/** One race: a label L, three issues, and the transactions' shared committed state. */
function world(step: () => Promise<void>) {
  const m = memoryIssues();
  const L = m.addLabel({ name: 'Flaky', teamId: m.eng.id });
  const M = m.addLabel({ name: 'Frontend', teamId: m.eng.id });
  const issue = (labelIds: string[], extra: Partial<IssueRow> = {}): IssueRow => {
    const row: IssueRow = {
      id: randomUUID(),
      teamId: m.eng.id,
      number: m.issues.size + 1,
      title: 'An issue',
      statusId: m.eng.defaultStatusId,
      priority: 0,
      assigneeId: null,
      creatorId: randomUUID(),
      labelIds,
      estimate: null,
      dueDate: null,
      sortOrder: `a${m.issues.size}`,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      deletedAt: null,
      deletedById: null,
      syncGroups: [`team:${m.eng.id}`],
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    };
    m.issues.set(row.id, row);
    return row;
  };
  // Already carries L; edited concurrently to add M (its labels are rewritten by both).
  const tagged = issue([L.id]);
  // Gets L from a concurrent edit.
  const plain = issue([]);
  // Archived, with L: the cascade rewrites it anyway.
  const archived = issue([L.id], { archivedAt: NOW });

  const locks = new Locks();
  let nextTx = 0;

  /** Runs `body` as one transaction: its writes show at commit; its locks go at the end. */
  async function transaction<T>(
    body: (tx: number, pending: (() => void)[]) => Promise<T>,
  ): Promise<T> {
    const tx = ++nextTx;
    const pending: (() => void)[] = [];
    try {
      const result = await body(tx, pending);
      for (const write of pending) write();
      return result;
    } finally {
      locks.release(tx);
    }
  }

  function issueAccess(tx: number): IssueAccess {
    const locked = async (row: string, mode: Mode) => {
      await step();
      await locks.acquire(tx, row, mode);
    };
    return {
      shareTeam: async (teamId) => {
        await locked(`team:${teamId}`, 'keyShare');
        return teamId === m.eng.id ? m.eng : undefined;
      },
      readTeam: async (teamId) => {
        await step();
        return teamId === m.eng.id ? m.eng : undefined;
      },
      shareStatus: () => Promise.reject(new Error('no status changes here')),
      async shareLabels(ids) {
        const rows: LabelRow[] = [];
        for (const id of ids) {
          await locked(`label:${id}`, 'keyShare');
          const row = m.labels.get(id);
          if (row) rows.push(row);
        }
        return rows;
      },
      readLabels: async (ids) => {
        await step();
        return ids.flatMap((id) => m.labels.get(id) ?? []);
      },
      statusCategory: () => Promise.resolve(undefined),
      position: () => Promise.reject(new Error('no creates here')),
      async lockIssue(issueId, mode: IssueLockMode) {
        await locked(`issue:${issueId}`, 'update');
        const row = m.issues.get(issueId);
        if (!row) throw new Error('no such issue');
        const state = lifecycleOf(row);
        const refused = lockRefusal(mode, state);
        if (refused) throw new SurfaceError('CONFLICT', lifecycleRefusal('ENG-1', refused));
        return { ...row, state };
      },
    };
  }

  function edit(issueId: string, addLabelIds: string[]) {
    return transaction((tx, pending) => {
      const repo = {
        update(model: string, id: string, patch: Partial<IssueRow>) {
          if (model !== 'Issue') throw new Error(`unexpected update of ${model}`);
          pending.push(() => {
            const row = m.issues.get(id);
            if (row) m.issues.set(id, { ...row, ...patch, updatedAt: NOW });
          });
          return Promise.resolve({ ...m.issues.get(id), ...patch });
        },
      } as unknown as Repo;
      return updateIssue(
        { access: issueAccess(tx), repo, emit: () => undefined, now: NOW },
        { issueId, teamId: m.eng.id, addLabelIds, removeLabelIds: [] },
      );
    });
  }

  function deleteL() {
    return transaction(async (tx, pending) => {
      const locked = async (row: string) => {
        await step();
        await locks.acquire(tx, row, 'update');
      };
      const access: LabelAccess = {
        lockWorkspace: () => locked('workspace'),
        async lockTeam(teamId) {
          await locked(`team:${teamId}`);
          return teamId === m.eng.id ? { id: teamId, key: 'ENG' } : undefined;
        },
        async scopeLabels(teamId) {
          await step();
          return [...m.labels.values()].filter((l) => l.teamId === teamId);
        },
        async lockLabel(id) {
          await locked(`label:${id}`);
          return m.labels.get(id);
        },
        shareLabel: () => Promise.reject(new Error('no group here')),
        async removeFromIssues(labelId) {
          // `removeLabelFromIssues`: SELECT … FOR UPDATE in ascending id over the rows that carry
          // the label now; a row it waited for is checked again (Postgres re-evaluates the
          // condition on the newest version), then `array_remove` runs on the locked row.
          await step();
          const found = [...m.issues.values()]
            .filter((row) => row.labelIds.includes(labelId))
            .map((row) => row.id)
            .sort();
          const ids: string[] = [];
          for (const id of found) {
            await locked(`issue:${id}`);
            if (m.issues.get(id)?.labelIds.includes(labelId) !== true) continue;
            ids.push(id);
            pending.push(() => {
              const row = m.issues.get(id);
              if (row) {
                m.issues.set(id, { ...row, labelIds: row.labelIds.filter((l) => l !== labelId) });
              }
            });
          }
          return ids;
        },
        visibleIssueCount: (ids) => Promise.resolve(ids.length),
      };
      const repo = {
        purge(model: string, id: string) {
          if (model !== 'Label') throw new Error(`unexpected purge of ${model}`);
          pending.push(() => m.labels.delete(id));
          return Promise.resolve();
        },
      } as unknown as Repo;
      return deleteLabel(access, repo, { label: { id: L.id, teamId: L.teamId } });
    });
  }

  return { m, L, M, tagged, plain, archived, edit, deleteL };
}

/** Lets every transaction that can move ask for its next step. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

describe('label.delete raced with issue.update (§4.4, AC-19 label race, AC-10)', () => {
  it('never deadlocks and never leaves an issue with the deleted label', async () => {
    let addedFirst = 0;
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.boolean(), async (s, editsFirst) => {
        const w = world(() => s.schedule(Promise.resolve()).then(() => undefined));
        const outcomes = new Map<string, Outcome>();
        const track = (name: string, run: () => Promise<unknown>) =>
          void run().then(
            (value) => outcomes.set(name, { ok: true, value }),
            (error: unknown) => outcomes.set(name, { ok: false, error }),
          );
        const runs: [string, () => Promise<unknown>][] = [
          ['addL', () => w.edit(w.plain.id, [w.L.id])],
          ['addM', () => w.edit(w.tagged.id, [w.M.id])],
          ['delete', () => w.deleteL()],
        ];
        // Which one is queued first matters only for the scheduler's first pick.
        for (const [name, run] of editsFirst ? runs : [...runs].reverse()) track(name, run);
        for (;;) {
          await settle();
          if (s.count() === 0) break;
          await s.waitNext(1);
        }
        await settle();

        // Every transaction ended: none waits forever, and no wait-for cycle was found.
        expect([...outcomes.keys()].sort(), JSON.stringify(s.report())).toEqual([
          'addL',
          'addM',
          'delete',
        ]);
        for (const outcome of outcomes.values()) {
          if (!outcome.ok) expect(outcome.error).not.toBeInstanceOf(Deadlock);
        }
        const del = outcomes.get('delete');
        expect(del?.ok, JSON.stringify(s.report())).toBe(true);
        expect(w.m.labels.has(w.L.id)).toBe(false);
        // No issue references the deleted label, archived ones included.
        for (const row of w.m.issues.values()) expect(row.labelIds).not.toContain(w.L.id);
        // The other label added meanwhile stays (array_remove on the locked row).
        expect(outcomes.get('addM')?.ok, JSON.stringify(s.report())).toBe(true);
        expect(w.m.issues.get(w.tagged.id)?.labelIds).toEqual([w.M.id]);
        expect(w.m.issues.get(w.archived.id)?.archivedAt).toEqual(NOW);

        const addL = outcomes.get('addL');
        const removed = del?.ok === true ? (del.value as { removedFromIssues: number }) : undefined;
        if (addL?.ok === true) {
          // The edit committed first: the cascade found and rewrote its issue too.
          addedFirst++;
          expect(removed?.removedFromIssues).toBe(3);
        } else {
          refused++;
          expect(addL?.ok === false && addL.error).toBeInstanceOf(SurfaceError);
          expect(addL?.ok === false && addL.error).toMatchObject({
            code: 'CONFLICT',
            message: LABEL_GONE,
          });
          expect(removed?.removedFromIssues).toBe(2);
          expect(w.m.issues.get(w.plain.id)?.labelIds).toEqual([]);
        }
      }),
      { seed: 20261116, numRuns: 300 },
    );
    // Both orders happen across the runs.
    expect(addedFirst).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});

/** One status race: "In Review" (not the default, not alone in Started) and one issue in Todo. */
function statusWorld(step: () => Promise<void>) {
  const m = memoryIssues();
  const review = m.status(m.eng, 'In Review');
  const todo = m.status(m.eng, 'Todo');
  const issue: IssueRow = {
    id: randomUUID(),
    teamId: m.eng.id,
    number: 1,
    title: 'An issue',
    statusId: todo.id,
    priority: 0,
    assigneeId: null,
    creatorId: randomUUID(),
    labelIds: [],
    estimate: null,
    dueDate: null,
    sortOrder: 'a0',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedById: null,
    syncGroups: [`team:${m.eng.id}`],
    createdAt: NOW,
    updatedAt: NOW,
  };
  m.issues.set(issue.id, issue);
  const locks = new Locks();
  let nextTx = 0;

  async function transaction<T>(
    body: (tx: number, pending: (() => void)[]) => Promise<T>,
  ): Promise<T> {
    const tx = ++nextTx;
    const pending: (() => void)[] = [];
    try {
      const result = await body(tx, pending);
      for (const write of pending) write();
      return result;
    } finally {
      locks.release(tx);
    }
  }

  const statusRow = (id: string): StatusRow | undefined => {
    const found = m.statuses.get(id);
    return (
      found && {
        ...found,
        color: 'gray',
        description: null,
        position: 'a0',
        archivedAt: null,
        syncGroups: ['workspace'],
        createdAt: NOW,
        updatedAt: NOW,
      }
    );
  };

  /** `issue.update` moving the issue into In Review. */
  function moveIn() {
    return transaction((tx, pending) => {
      const locked = async (row: string, mode: Mode) => {
        await step();
        await locks.acquire(tx, row, mode);
      };
      const access: IssueAccess = {
        shareTeam: () => Promise.reject(new Error('no creates here')),
        readTeam: async (teamId) => {
          await step();
          return teamId === m.eng.id ? m.eng : undefined;
        },
        async shareStatus(statusId) {
          await locked(`status:${statusId}`, 'keyShare');
          const found = m.statuses.get(statusId);
          return found && { id: found.id, teamId: found.teamId, category: found.category };
        },
        shareLabels: () => Promise.resolve([]),
        readLabels: () => Promise.resolve([]),
        statusCategory: (statusId) => Promise.resolve(m.statuses.get(statusId)?.category),
        position: () => Promise.reject(new Error('no creates here')),
        async lockIssue(issueId, mode: IssueLockMode) {
          await locked(`issue:${issueId}`, 'update');
          const row = m.issues.get(issueId);
          if (!row) throw new Error('no such issue');
          const state = lifecycleOf(row);
          const refused = lockRefusal(mode, state);
          if (refused) throw new SurfaceError('CONFLICT', lifecycleRefusal('ENG-1', refused));
          return { ...row, state };
        },
      };
      const repo = {
        update(model: string, id: string, patch: Partial<IssueRow>) {
          if (model !== 'Issue') throw new Error(`unexpected update of ${model}`);
          pending.push(() => {
            const row = m.issues.get(id);
            if (row) m.issues.set(id, { ...row, ...patch, updatedAt: NOW });
          });
          return Promise.resolve({ ...m.issues.get(id), ...patch });
        },
      } as unknown as Repo;
      return updateIssue(
        { access, repo, emit: () => undefined, now: NOW },
        {
          issueId: issue.id,
          teamId: m.eng.id,
          statusId: review.id,
          statusRef: 'In Review',
          addLabelIds: [],
          removeLabelIds: [],
        },
      );
    });
  }

  /** `status.delete` of In Review. */
  function deleteReview() {
    return transaction(async (tx, pending) => {
      const locked = async (row: string) => {
        await step();
        await locks.acquire(tx, row, 'update');
      };
      const access: WorkflowAccess = {
        async lockTeam(teamId) {
          await locked(`team:${teamId}`);
          return teamId === m.eng.id
            ? {
                id: m.eng.id,
                key: m.eng.key,
                defaultStatusId: m.eng.defaultStatusId,
                autoCloseStatusId: null,
              }
            : undefined;
        },
        async statuses(teamId) {
          await step();
          return [...m.statuses.keys()]
            .flatMap((id) => statusRow(id) ?? [])
            .filter((row) => row.teamId === teamId);
        },
        async lockStatus(statusId) {
          await locked(`status:${statusId}`);
          return statusRow(statusId);
        },
        shareStatus: () => Promise.reject(new Error('no anchor here')),
        async issueCounts(statusId) {
          // A plain read of committed rows: no lock (§4.4).
          await step();
          return countStatusIssues([...m.issues.values()], statusId);
        },
      };
      const repo = {
        purge(model: string, id: string) {
          if (model !== 'WorkflowStatus') throw new Error(`unexpected purge of ${model}`);
          pending.push(() => m.statuses.delete(id));
          return Promise.resolve();
        },
      } as unknown as Repo;
      return deleteStatus(access, repo, {
        teamRef: 'ENG',
        team: { id: m.eng.id, key: m.eng.key },
        statusId: review.id,
      });
    });
  }

  return { m, review, issue, moveIn, deleteReview };
}

const now = () => Promise.resolve();
const outcome = (run: () => Promise<unknown>): Promise<Outcome> =>
  run().then(
    (value): Outcome => ({ ok: true, value }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );

describe('status.delete raced with issue.update into the same status (E16, §4.4)', () => {
  it('when the edit commits first, the delete is refused for its issue and the status stays', async () => {
    const w = statusWorld(now);
    expect(await outcome(() => w.moveIn())).toMatchObject({ ok: true });
    const deleted = await outcome(() => w.deleteReview());
    expect(deleted).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message:
          'Can\'t delete the "In Review" status. It has 1 issue. Move it to another status first.',
      },
    });
    expect(w.m.statuses.has(w.review.id)).toBe(true);
    expect(w.m.issues.get(w.issue.id)?.statusId).toBe(w.review.id);
  });

  it('when the delete commits first, the edit is CONFLICT and the issue keeps its status', async () => {
    const w = statusWorld(now);
    expect(await outcome(() => w.deleteReview())).toMatchObject({ ok: true });
    const moved = await outcome(() => w.moveIn());
    expect(moved).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: STATUS_GONE } });
    expect(w.m.statuses.has(w.review.id)).toBe(false);
    expect(w.m.issues.get(w.issue.id)?.statusId).not.toBe(w.review.id);
  });

  it('interleaved anyhow, exactly one of them commits and no issue is left on a deleted status', async () => {
    let editFirst = 0;
    let deleteFirst = 0;
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.boolean(), async (s, editQueuedFirst) => {
        const w = statusWorld(() => s.schedule(Promise.resolve()).then(() => undefined));
        const outcomes = new Map<string, Outcome>();
        const runs: [string, () => Promise<unknown>][] = [
          ['edit', () => w.moveIn()],
          ['delete', () => w.deleteReview()],
        ];
        for (const [name, run] of editQueuedFirst ? runs : [...runs].reverse()) {
          void outcome(run).then((result) => outcomes.set(name, result));
        }
        for (;;) {
          await settle();
          if (s.count() === 0) break;
          await s.waitNext(1);
        }
        await settle();
        const report = JSON.stringify(s.report());
        const edit = outcomes.get('edit');
        const del = outcomes.get('delete');
        expect(edit, report).toBeDefined();
        expect(del, report).toBeDefined();
        for (const result of [edit, del]) {
          if (result?.ok === false) {
            expect(result.error, report).not.toBeInstanceOf(Deadlock);
            expect(result.error, report).toMatchObject({ code: 'CONFLICT' });
          }
        }
        expect(edit?.ok !== del?.ok, report).toBe(true);
        if (edit?.ok === true) editFirst++;
        else deleteFirst++;
        const statusId = w.m.issues.get(w.issue.id)?.statusId ?? '';
        expect(w.m.statuses.has(statusId), report).toBe(true);
      }),
      { seed: 20261116, numRuns: 200 },
    );
    expect(editFirst).toBeGreaterThan(0);
    expect(deleteFirst).toBeGreaterThan(0);
  });
});
