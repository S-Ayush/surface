// PLAN-011 S6, SPEC-011 §4.4: the history writer (`issues/history.ts`) as the issue handlers run
// it. AC-5 (one entry per changing operation with every changed field and names, `apiKeyId` for
// key actors, no-op updates write nothing, the folds after the issue lock), E4, E16, E21, and
// SPEC-015 AC-12 (`writeLifecycleHistory`: one `deleted` or `restored` entry with empty `changes`,
// never folded, with the actor's kind and key). The domain rules have their own tests
// (`packages/domain/src/issue-history.test.ts`); the rows here are the in-memory workspace's.
import { randomUUID } from 'node:crypto';
import { systemActor, type Actor, type DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../src/executor/context.js';
import {
  createIssue,
  updateDescription,
  updateIssue,
  type CreateIssueInput,
  type IssueRow,
  type UpdateIssueInput,
} from '../src/handlers/issues/core.js';
import { historyActorOf, writeLifecycleEntry, writeUpdatedHistory } from '../src/issues/history.js';
import { writeLifecycleHistory } from '../src/issues/lifecycle.js';
import {
  ADA_ACTOR,
  ADA_ID,
  memoryIssues,
  NOW,
  type MemoryIssues,
} from './support/memory-issues.js';
import { recordingDb } from './support/scripted-db.js';

const KEY_ID = '0192f0c1-7e5a-7b3c-9d4e-00000000c0de';
const BOB_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000b0';
const viaKey = (kind: 'api' | 'mcp'): Actor => ({
  ...ADA_ACTOR,
  kind,
  apiKey: { id: KEY_ID, scope: 'read_write', teamIds: [], allowDestructive: false },
});
const bob: Actor = { ...ADA_ACTOR, userId: BOB_ID, groups: ['workspace', `user:${BOB_ID}`] };

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const paragraph = (text: string): DocNodeJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function create(m: MemoryIssues, extra: Partial<CreateIssueInput> = {}): Promise<IssueRow> {
  return createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
    ...extra,
  });
}

function update(m: MemoryIssues, issue: IssueRow, extra: Partial<UpdateIssueInput> = {}) {
  return updateIssue(m.ctx, {
    issueId: issue.id,
    teamId: issue.teamId,
    addLabelIds: [],
    removeLabelIds: [],
    ...extra,
  });
}

const entries = (m: MemoryIssues, issue: IssueRow) =>
  m.historyRows.filter((r) => r.issueId === issue.id);

describe('the created entry', () => {
  it('holds { to } of each non-default field, with names, as the creating actor', async () => {
    const m = memoryIssues();
    const bug = m.addLabel({ name: 'Bug', color: 'red' });
    const todo = m.status(m.eng, 'Todo');
    const issue = await create(m, {
      statusId: todo.id,
      priority: 2,
      assigneeId: ADA_ID,
      labelIds: [bug.id],
      description: paragraph('Steps'),
    });
    expect(entries(m, issue)).toEqual([
      expect.objectContaining({
        kind: 'created',
        issueId: issue.id,
        teamId: issue.teamId,
        actorKind: 'user',
        actorId: ADA_ID,
        apiKeyId: null,
        changes: {
          title: { to: 'Fix login' },
          status: { to: { id: todo.id, name: 'Todo', category: 'unstarted' } },
          priority: { to: 2 },
          assignee: { to: { id: ADA_ID, name: 'Ada' } },
          labels: { to: [{ id: bug.id, name: 'Bug', color: 'red' }] },
          description: true,
        },
      }),
    ]);
  });

  it.each(['api', 'mcp'] as const)('names the key of an %s actor (apiKeyId)', async (kind) => {
    const m = memoryIssues();
    m.as(viaKey(kind));
    const issue = await create(m);
    expect(entries(m, issue)[0]).toMatchObject({
      actorKind: kind,
      actorId: ADA_ID,
      apiKeyId: KEY_ID,
    });
  });
});

describe('updated entries (AC-5)', () => {
  /** An issue created 10 minutes ago, so the creator fold is over. */
  async function settled(extra: Partial<CreateIssueInput> = {}) {
    const m = memoryIssues();
    const issue = await create(m, extra);
    m.at(minutes(10));
    return { m, issue };
  }

  it('one entry per changing operation, with every changed field and the names (E16)', async () => {
    const { m, issue } = await settled();
    const bug = m.addLabel({ name: 'Bug', color: 'red' });
    const progress = m.status(m.eng, 'In Progress');
    m.as(bob);
    await update(m, issue, {
      title: 'Fix the login',
      statusId: progress.id,
      assigneeId: BOB_ID,
      addLabelIds: [bug.id],
      dueDate: '2026-12-01',
    });
    const backlog = m.status(m.eng, 'Backlog');
    expect(entries(m, issue).map((e) => e.kind)).toEqual(['created', 'updated']);
    expect(entries(m, issue)[1]).toMatchObject({
      actorKind: 'user',
      actorId: BOB_ID,
      apiKeyId: null,
      changes: {
        title: { from: 'Fix login', to: 'Fix the login' },
        status: {
          from: { id: backlog.id, name: 'Backlog', category: 'backlog' },
          to: { id: progress.id, name: 'In Progress', category: 'started' },
        },
        assignee: { from: null, to: { id: BOB_ID } },
        labels: { added: [{ id: bug.id, name: 'Bug', color: 'red' }], removed: [] },
        dueDate: { from: null, to: '2026-12-01' },
      },
    });
    // A rename later doesn't change what the entry shows (E16).
    m.labels.set(bug.id, { ...bug, name: 'Defect' });
    expect(JSON.stringify(entries(m, issue)[1]?.changes)).toContain('"Bug"');
  });

  it('two people changing the same field get one entry each (E4)', async () => {
    const { m, issue } = await settled();
    m.as(bob);
    await update(m, issue, { priority: 1 });
    m.as(ADA_ACTOR);
    await update(m, issue, { priority: 2 });
    expect(entries(m, issue).map((e) => [e.kind, e.actorId, e.changes])).toEqual([
      ['created', ADA_ID, { title: { to: 'Fix login' } }],
      ['updated', BOB_ID, { priority: { from: 0, to: 1 } }],
      ['updated', ADA_ID, { priority: { from: 1, to: 2 } }],
    ]);
  });

  it('a no-op update writes no entry (E12)', async () => {
    const { m, issue } = await settled();
    await update(m, issue, { title: 'Fix login', priority: 0 });
    expect(entries(m, issue).map((e) => e.kind)).toEqual(['created']);
  });

  it.each(['api', 'mcp'] as const)('names the key of an %s actor', async (kind) => {
    const { m, issue } = await settled();
    m.as(viaKey(kind));
    await update(m, issue, { priority: 3 });
    expect(entries(m, issue).at(-1)).toMatchObject({
      kind: 'updated',
      actorKind: kind,
      actorId: ADA_ID,
      apiKeyId: KEY_ID,
    });
  });

  it('reads the latest entry only after the issue lock, so two folds can’t race', async () => {
    const { m, issue } = await settled();
    m.calls.length = 0;
    await update(m, issue, { priority: 1 });
    expect(m.calls.indexOf('lockIssue')).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf('lockIssue')).toBeLessThan(m.calls.indexOf('latestHistory'));
    m.calls.length = 0;
    await updateDescription(m.ctx, {
      issueId: issue.id,
      baseVersion: 1,
      description: paragraph('Text'),
    });
    expect(m.calls.indexOf('lockIssue')).toBeLessThan(m.calls.indexOf('latestHistory'));
  });
});

describe('folds (§4.4)', () => {
  it('the creator’s changes within 3 minutes fold into created, dropping defaults', async () => {
    const m = memoryIssues();
    const issue = await create(m, { priority: 2 });
    m.at(minutes(1));
    await update(m, issue, { priority: 0, dueDate: '2026-12-01' });
    m.at(minutes(3));
    await updateDescription(m.ctx, {
      issueId: issue.id,
      baseVersion: 1,
      description: paragraph('Added'),
    });
    expect(entries(m, issue)).toEqual([
      expect.objectContaining({
        kind: 'created',
        changes: { title: { to: 'Fix login' }, dueDate: { to: '2026-12-01' }, description: true },
        createdAt: NOW,
        updatedAt: minutes(3),
      }),
    ]);
    // Folded rows are a `U` of the entry (the repo's update), never a second insert.
    expect(m.writes.filter((w) => w.model === 'IssueHistory').map((w) => w.action)).toEqual([
      'insert',
      'update',
      'update',
    ]);
  });

  it('after 3 minutes, or by someone else, a change gets its own entry', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    m.at(new Date(minutes(3).getTime() + 1));
    await update(m, issue, { priority: 1 });
    expect(entries(m, issue).map((e) => e.kind)).toEqual(['created', 'updated']);
    const other = await create(m);
    m.as(bob);
    await update(m, other, { priority: 1 });
    expect(entries(m, other).map((e) => e.kind)).toEqual(['created', 'updated']);
  });

  it('autosave five times in a minute gives one description entry (E21)', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    m.at(minutes(10));
    m.as(bob);
    for (let i = 0; i < 5; i++) {
      m.at(new Date(minutes(10).getTime() + i * 12_000));
      await updateDescription(m.ctx, {
        issueId: issue.id,
        baseVersion: i + 1,
        description: paragraph(`Draft ${i}`),
      });
    }
    expect(entries(m, issue).map((e) => [e.kind, e.changes])).toEqual([
      ['created', { title: { to: 'Fix login' } }],
      ['updated', { description: true }],
    ]);
    // A save 10 minutes after the last fold starts a new entry.
    m.at(new Date(minutes(10).getTime() + 4 * 12_000 + 10 * 60_000 + 1));
    await updateDescription(m.ctx, {
      issueId: issue.id,
      baseVersion: 6,
      description: paragraph('Later'),
    });
    expect(entries(m, issue).map((e) => e.kind)).toEqual(['created', 'updated', 'updated']);
  });
});

describe('the system actor (PLAN-015 S3’s auto-close and auto-archive)', () => {
  it('writes an updated entry with actor system and no user, never folded into created', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    const done = m.status(m.eng, 'Canceled');
    const backlog = m.status(m.eng, 'Backlog');
    m.as(systemActor());
    const row = await writeUpdatedHistory(
      { access: m.ctx.access, repo: m.repo, actor: systemActor(), now: NOW },
      issue,
      { statusId: { from: backlog.id, to: done.id } },
    );
    expect(row).toMatchObject({
      kind: 'updated',
      actorKind: 'system',
      actorId: null,
      apiKeyId: null,
      changes: {
        status: {
          from: { id: backlog.id, name: 'Backlog', category: 'backlog' },
          to: { id: done.id, name: 'Canceled', category: 'canceled' },
        },
      },
    });
  });

  it('writes an archived entry with empty changes', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    const row = await writeLifecycleEntry(
      { access: m.ctx.access, repo: m.repo, actor: systemActor(), now: NOW },
      'archived',
      issue,
    );
    expect(row).toMatchObject({
      kind: 'archived',
      actorKind: 'system',
      actorId: null,
      changes: {},
    });
  });

  it('historyActorOf: system has no user; a key actor without a key has a null apiKeyId', () => {
    expect(historyActorOf(systemActor())).toEqual({
      actorKind: 'system',
      actorId: null,
      apiKeyId: null,
    });
    expect(historyActorOf({ ...ADA_ACTOR, kind: 'mcp' })).toEqual({
      actorKind: 'mcp',
      actorId: ADA_ID,
      apiKeyId: null,
    });
  });
});

describe('writeLifecycleHistory (SPEC-015 AC-12)', () => {
  /** The handler context the lifecycle handlers pass: the history writer reads nothing here. */
  function handlerContext(m: MemoryIssues, actor: Actor, now = NOW): HandlerContext {
    const ctx: Pick<HandlerContext, 'tx' | 'repo' | 'actor' | 'now'> = {
      tx: recordingDb().db,
      repo: m.repo,
      actor,
      now: () => now,
    };
    return ctx as HandlerContext;
  }

  it.each(['deleted', 'restored'] as const)(
    'writes one %s entry with empty changes, as the actor with its key',
    async (kind) => {
      const m = memoryIssues();
      const issue = await create(m);
      await writeLifecycleHistory(handlerContext(m, viaKey('api')), kind, issue);
      expect(entries(m, issue).at(-1)).toMatchObject({
        kind,
        issueId: issue.id,
        teamId: issue.teamId,
        actorKind: 'api',
        actorId: ADA_ID,
        apiKeyId: KEY_ID,
        changes: {},
      });
    },
  );

  it('writes the auto-archive job’s archived entry as the system actor (PLAN-015 S3)', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    await writeLifecycleHistory(handlerContext(m, systemActor()), 'archived', issue);
    expect(entries(m, issue).map((e) => [e.kind, e.actorKind, e.actorId, e.changes])).toEqual([
      ['created', 'user', ADA_ID, { title: { to: 'Fix login' } }],
      ['archived', 'system', null, {}],
    ]);
  });

  it('never folds: a delete and restore within a minute by the creator are two entries', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    await writeLifecycleHistory(handlerContext(m, ADA_ACTOR), 'deleted', issue);
    await writeLifecycleHistory(handlerContext(m, ADA_ACTOR), 'restored', issue);
    expect(entries(m, issue).map((e) => [e.kind, e.changes])).toEqual([
      ['created', { title: { to: 'Fix login' } }],
      ['deleted', {}],
      ['restored', {}],
    ]);
    // And a description change right after a restore is not folded into it.
    await updateDescription(m.ctx, {
      issueId: issue.id,
      baseVersion: 1,
      description: paragraph('After'),
    });
    expect(entries(m, issue).map((e) => e.kind)).toEqual([
      'created',
      'deleted',
      'restored',
      'updated',
    ]);
  });
});
