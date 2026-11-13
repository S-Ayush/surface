// PLAN-015 S1, SPEC-015: `issue.delete` and `issue.restore` (§4.2, §4.8, §5.1, §6.4).
// Idempotence (a repeat writes, records and emits nothing), AC-3 (the 720 h boundary on the
// server, with a fake clock), AC-12 (one `deleted` and one `restored` history entry, never more),
// AC-21 (restore logs the issue's Attachment rows again after the Issue's `V`/`U`, through
// `updateWhere` with an empty patch and `touchUpdatedAt: false`, at most 100, none for a no-op or
// an issue without attachments; checked with fake Attachment rows until PLAN-014 S4a adds the
// model), E3 and E15 (two fake transactions on one issue run one after the other under the row
// lock), E4. The rules run on the in-memory workspace (`support/memory-issues.ts`); the SQL of
// the lock is `issue-lock.test.ts`'s.
import { randomUUID } from 'node:crypto';
import { purgeAfter, type Actor } from '@surface/domain';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { issueContent } from '../src/db/schema/index.js';
import { SurfaceError } from '../src/executor/errors.js';
import { createIssue, updateIssue, type IssueRow } from '../src/handlers/issues/core.js';
import {
  deleteIssue,
  restoreIssue,
  type LifecycleContext,
} from '../src/handlers/issues/lifecycle-core.js';
import { relogByIssueId, RESTORE_RELOG_STEPS } from '../src/issues/lifecycle.js';
import type { ModelName } from '../src/sync/models.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';
import { recordingDb } from './support/scripted-db.js';

const EARLIER = new Date('2026-10-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type State = 'live' | 'archived' | 'deleted' | 'archivedAndDeleted';

/** A fresh workspace holding ENG-1 in `state`, last updated at EARLIER, with nothing recorded. */
async function issueIn(
  state: State,
  deletedAt: Date = new Date(NOW.getTime() - 24 * HOUR),
): Promise<{ m: MemoryIssues; issue: IssueRow }> {
  const m = memoryIssues();
  const created = await createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
  });
  const issue: IssueRow = {
    ...created,
    archivedAt: state === 'archived' || state === 'archivedAndDeleted' ? EARLIER : null,
    deletedAt: state === 'deleted' || state === 'archivedAndDeleted' ? deletedAt : null,
    deletedById: state === 'deleted' || state === 'archivedAndDeleted' ? ADA_ID : null,
    updatedAt: EARLIER,
  };
  m.issues.set(issue.id, issue);
  m.writes.length = 0;
  m.events.length = 0;
  m.calls.length = 0;
  m.lockModes.length = 0;
  return { m, issue };
}

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const attachmentIds = (count: number) =>
  Array.from({ length: count }, (_, i) => `0190f0c0-0000-7000-8000-${String(i).padStart(12, '0')}`);

describe('issue.delete (§4.2)', () => {
  it('moves a live issue to Deleted with one U, a deleted entry and an issue.deleted event', async () => {
    const { m, issue } = await issueIn('live');
    const { row, changed } = await deleteIssue(m.lifecycle(), issue.id);
    expect(changed).toBe(true);
    expect(row).toMatchObject({ deletedAt: NOW, deletedById: ADA_ID, archivedAt: null });
    expect(m.lockModes).toEqual(['lifecycle']);
    expect(m.writes).toEqual([
      { action: 'update', ids: [issue.id], fields: ['deletedAt', 'deletedById'] },
    ]);
    expect(m.history).toEqual([{ kind: 'deleted', issueId: issue.id }]);
    expect(m.events).toEqual([
      {
        type: 'issue.deleted',
        subject: { type: 'issue', id: issue.id },
        data: { teamId: m.eng.id, number: 1 },
      },
    ]);
  });

  it('keeps archivedAt when it deletes an archived issue, until a restore', async () => {
    const { m, issue } = await issueIn('archived');
    const { row } = await deleteIssue(m.lifecycle(), issue.id);
    expect(row).toMatchObject({ archivedAt: EARLIER, deletedAt: NOW });
  });

  it('changes nothing for a deleted issue: no write, no history, no event', async () => {
    for (const state of ['deleted', 'archivedAndDeleted'] as const) {
      const { m, issue } = await issueIn(state);
      const { row, changed } = await deleteIssue(m.lifecycle(), issue.id);
      expect(changed).toBe(false);
      expect(row).toEqual(issue);
      expect(m.writes).toEqual([]);
      expect(m.history).toEqual([]);
      expect(m.events).toEqual([]);
    }
  });

  it('records the key owner for an API key and nobody for the system actor (§4.1)', async () => {
    const key: Actor = {
      kind: 'api',
      userId: ADA_ID,
      groups: ['workspace'],
      memberOf: [],
      apiKey: { id: 'key-1', scope: 'read_write', teamIds: [], allowDestructive: true },
    };
    const byKey = await issueIn('live');
    expect(
      (await deleteIssue(byKey.m.lifecycle({ actor: key }), byKey.issue.id)).row,
    ).toMatchObject({ deletedById: ADA_ID });
    const system: Actor = { kind: 'system', groups: [], memberOf: [] };
    const bySystem = await issueIn('live');
    const { row } = await deleteIssue(bySystem.m.lifecycle({ actor: system }), bySystem.issue.id);
    expect(row).toMatchObject({ deletedAt: NOW, deletedById: null });
  });
});

describe('issue.restore (§4.2, AC-3, AC-12)', () => {
  it('returns an archived issue to Live with a V, setting updatedAt (E20)', async () => {
    const { m, issue } = await issueIn('archived');
    const { row, changed } = await restoreIssue(m.lifecycle(), issue.id);
    expect(changed).toBe(true);
    expect(row).toMatchObject({ archivedAt: null, deletedAt: null, updatedAt: NOW });
    expect(m.lockModes).toEqual(['lifecycle']);
    expect(m.writes).toEqual([{ action: 'unarchive', ids: [issue.id], fields: ['archivedAt'] }]);
  });

  it('returns a deleted issue to Live with a U clearing deletedAt and deletedById', async () => {
    const { m, issue } = await issueIn('deleted');
    const { row } = await restoreIssue(m.lifecycle(), issue.id);
    expect(row).toMatchObject({ archivedAt: null, deletedAt: null, deletedById: null });
    expect(row.updatedAt).toEqual(NOW);
    expect(m.writes).toEqual([
      { action: 'update', ids: [issue.id], fields: ['deletedAt', 'deletedById'] },
    ]);
  });

  it('clears both states of a deleted and archived issue with V then U, and one restored entry', async () => {
    const { m, issue } = await issueIn('archivedAndDeleted');
    const { row } = await restoreIssue(m.lifecycle(), issue.id);
    expect(row).toMatchObject({ archivedAt: null, deletedAt: null, deletedById: null });
    expect(m.writes.map((w) => w.action)).toEqual(['unarchive', 'update']);
    expect(m.history).toEqual([{ kind: 'restored', issueId: issue.id }]);
    expect(m.events.map((e) => e.type)).toEqual(['issue.restored']);
  });

  it('changes nothing for a live issue: no write, no history, no event', async () => {
    const { m, issue } = await issueIn('live');
    m.attachments.set(issue.id, attachmentIds(2));
    const { row, changed } = await restoreIssue(m.lifecycle(), issue.id);
    expect(changed).toBe(false);
    expect(row).toEqual(issue);
    expect(m.writes).toEqual([]);
    expect(m.history).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it('restores 1 ms before purgeAfter, and refuses at it and after it with the §4.2 message (AC-3, E4)', async () => {
    const deletedAt = new Date('2026-10-14T09:30:00.000Z');
    const boundary = purgeAfter(deletedAt).getTime();
    expect(boundary - deletedAt.getTime()).toBe(720 * HOUR);

    const before = await issueIn('deleted', deletedAt);
    const restored = await restoreIssue(
      before.m.lifecycle({ now: new Date(boundary - 1) }),
      before.issue.id,
    );
    expect(restored.row.deletedAt).toBeNull();

    for (const at of [boundary, boundary + 1, boundary + 365 * 24 * HOUR]) {
      const { m, issue } = await issueIn('archivedAndDeleted', deletedAt);
      const error = await failure(restoreIssue(m.lifecycle({ now: new Date(at) }), issue.id));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toBe("ENG-1 was deleted more than 30 days ago and can't be restored.");
      expect(m.writes).toEqual([]);
      expect(m.history).toEqual([]);
      expect(m.events).toEqual([]);
    }
  });

  it('restores an archived issue however long ago it was archived', async () => {
    const { m, issue } = await issueIn('archived');
    const { row } = await restoreIssue(
      m.lifecycle({ now: new Date('2036-01-01T00:00:00.000Z') }),
      issue.id,
    );
    expect(row.archivedAt).toBeNull();
  });

  it('writes one deleted and one restored entry per transition, and none for repeats (AC-12)', async () => {
    const { m, issue } = await issueIn('live');
    const ctx = m.lifecycle();
    await deleteIssue(ctx, issue.id);
    await deleteIssue(ctx, issue.id);
    await restoreIssue(ctx, issue.id);
    await restoreIssue(ctx, issue.id);
    expect(m.history.map((h) => h.kind)).toEqual(['deleted', 'restored']);
    expect(m.events.map((e) => e.type)).toEqual(['issue.deleted', 'issue.restored']);
  });
});

describe('restore logs the Attachment rows again (AC-21, §5.1)', () => {
  it('after the Issue’s V and U, one updateWhere with an empty patch and touchUpdatedAt false', async () => {
    const { m, issue } = await issueIn('archivedAndDeleted');
    const ids = attachmentIds(3).reverse();
    m.attachments.set(issue.id, ids);
    await restoreIssue(m.lifecycle(), issue.id);
    expect(m.writes).toEqual([
      { action: 'unarchive', ids: [issue.id], fields: ['archivedAt'] },
      { action: 'update', ids: [issue.id], fields: ['deletedAt', 'deletedById'] },
      {
        action: 'updateWhere',
        model: 'Attachment',
        ids: [...ids].sort(),
        fields: [],
        touchUpdatedAt: false,
        patch: {},
      },
    ]);
  });

  it('logs at most 100 rows', async () => {
    const { m, issue } = await issueIn('deleted');
    m.attachments.set(issue.id, attachmentIds(150));
    await restoreIssue(m.lifecycle(), issue.id);
    const relog = m.writes.find((w) => w.model === 'Attachment');
    expect(relog?.ids).toHaveLength(100);
  });

  it('logs nothing more for an issue without attachments', async () => {
    const { m, issue } = await issueIn('archived');
    await restoreIssue(m.lifecycle(), issue.id);
    expect(m.writes.map((w) => w.action)).toEqual(['unarchive']);
  });

  it('has no registered step until PLAN-014 S4a adds the Attachment model', () => {
    expect(RESTORE_RELOG_STEPS).toEqual([]);
  });

  it('reads a model’s rows of the issue in ascending id, at most the limit (relogByIssueId)', async () => {
    const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
    const { db, statements } = recordingDb(() => [['b'], ['c']]);
    // `issue_content` stands in for PLAN-014 S4a's `attachments`: both have `id` and `issue_id`.
    const step = relogByIssueId('IssueContent' as ModelName, issueContent);
    expect(Object.keys(getTableColumns(issueContent))).toContain('issueId');
    await expect(step.ids(db, ISSUE, 100)).resolves.toEqual(['b', 'c']);
    expect(statements[0]?.text).toBe(
      'select "id" from "issue_content" where "issue_content"."issue_id" = $1 order by "issue_content"."id" asc limit $2',
    );
    expect(statements[0]?.params).toEqual([ISSUE, 100]);
  });
});

// ---------------------------------------------------------------------------------------------
// Two transactions on one issue (E3, E15). The fake row lock queues the second `lockIssue` until
// the first transaction ends, as `SELECT … FOR UPDATE` does; every write follows the lock, so a
// transaction refused at the lock wrote nothing to roll back.

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run (no timer: the queue only). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function rowLocks(m: MemoryIssues) {
  const held = new Map<string, Promise<void>>();
  /** Runs `body` as one transaction whose issue locks are held until it ends. */
  return async function transaction<T>(
    body: (ctx: { life: LifecycleContext; write: MemoryIssues['ctx'] }) => Promise<T>,
  ): Promise<T> {
    const releases: (() => void)[] = [];
    const lock = async (issueId: string) => {
      for (let wait = held.get(issueId); wait; wait = held.get(issueId)) await wait;
      const done = deferred();
      held.set(issueId, done.promise);
      releases.push(() => {
        held.delete(issueId);
        done.resolve();
      });
    };
    const life = m.lifecycle();
    try {
      return await body({
        life: {
          ...life,
          access: {
            ...life.access,
            lockIssue: async (id, mode) => (await lock(id), life.access.lockIssue(id, mode)),
          },
        },
        write: {
          ...m.ctx,
          access: {
            ...m.ctx.access,
            lockIssue: async (id, mode) => (await lock(id), m.ctx.access.lockIssue(id, mode)),
          },
        },
      });
    } finally {
      for (const release of releases) release();
    }
  };
}

describe('two people on one issue at once (E3, E15)', () => {
  it('applies a delete and a restore in lock order, and history shows both (E3)', async () => {
    const { m, issue } = await issueIn('live');
    const transaction = rowLocks(m);
    const gate = deferred();
    const first = transaction(async ({ life }) => {
      const result = await deleteIssue(life, issue.id);
      await gate.promise;
      return result;
    });
    await settle();
    const second = transaction(({ life }) => restoreIssue(life, issue.id));
    await settle();
    // The restore waits on the row lock: it hasn't locked, read or written anything yet.
    expect(m.lockModes).toEqual(['lifecycle']);
    expect(m.writes.map((w) => w.action)).toEqual(['update']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(m.issues.get(issue.id)).toMatchObject({ deletedAt: null, archivedAt: null });
    expect(m.history.map((h) => h.kind)).toEqual(['deleted', 'restored']);
  });

  it('a restore that wins the lock leaves the delete to apply after it (E3, other order)', async () => {
    const { m, issue } = await issueIn('deleted');
    const transaction = rowLocks(m);
    const gate = deferred();
    const first = transaction(async ({ life }) => {
      const result = await restoreIssue(life, issue.id);
      await gate.promise;
      return result;
    });
    await settle();
    const second = transaction(({ life }) => deleteIssue(life, issue.id));
    await settle();
    gate.resolve();
    await Promise.all([first, second]);
    expect(m.issues.get(issue.id)?.deletedAt).toEqual(NOW);
    expect(m.history.map((h) => h.kind)).toEqual(['restored', 'deleted']);
  });

  it('an edit that loses the lock to a delete is CONFLICT and writes nothing (E15)', async () => {
    const { m, issue } = await issueIn('live');
    const transaction = rowLocks(m);
    const gate = deferred();
    const deleting = transaction(async ({ life }) => {
      await deleteIssue(life, issue.id);
      await gate.promise;
    });
    await settle();
    const editing = transaction(({ write }) =>
      updateIssue(write, {
        issueId: issue.id,
        teamId: issue.teamId,
        title: 'Fix login again',
        addLabelIds: [],
        removeLabelIds: [],
      }),
    );
    await settle();
    gate.resolve();
    await deleting;
    const error = await failure(editing);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('ENG-1 was deleted. Restore it to edit it.');
    expect(m.writes.map((w) => w.fields)).toEqual([['deletedAt', 'deletedById']]);
    expect(m.issues.get(issue.id)?.title).toBe('Fix login');
  });

  it('an edit that wins the lock lands, then the delete applies after it (E15)', async () => {
    const { m, issue } = await issueIn('live');
    const transaction = rowLocks(m);
    const gate = deferred();
    const editing = transaction(async ({ write }) => {
      await updateIssue(write, {
        issueId: issue.id,
        teamId: issue.teamId,
        title: 'Fix login again',
        addLabelIds: [],
        removeLabelIds: [],
      });
      await gate.promise;
    });
    await settle();
    const deleting = transaction(({ life }) => deleteIssue(life, issue.id));
    await settle();
    expect(m.issues.get(issue.id)?.deletedAt).toBeNull();
    gate.resolve();
    await Promise.all([editing, deleting]);
    expect(m.issues.get(issue.id)).toMatchObject({ title: 'Fix login again', deletedAt: NOW });
    expect(m.writes.map((w) => w.fields)).toEqual([['title'], ['deletedAt', 'deletedById']]);
  });
});
