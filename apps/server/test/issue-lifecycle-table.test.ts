// PLAN-015 S1, SPEC-015 §4.3–§4.4: AC-1 (every row of the lifecycle rule table holds: the
// operation's handler locks the issue in the row's mode, before any write, and gets the listed
// result for a live, an archived and a deleted issue), AC-2 (direct edits of archived and deleted
// issues are CONFLICT with the §4.2 wording and no repo write; cascades write archived and deleted
// issues and leave their lifecycle and `updatedAt` alone: E11), E15's refusal wording. Each built
// row's registered handler also runs on SQL, which shows its first `issues` statement is the
// `FOR UPDATE` lock and that no write comes before it. A row whose
// handler doesn't exist yet is listed as pending, by the slice that adds it; a built row with no
// case here fails, and so does an issue mutation with no row.
import { randomUUID } from 'node:crypto';
import {
  NEW_TEAM_SETTINGS,
  ISSUE_LIFECYCLE_RULES,
  ISSUE_LIFECYCLES,
  purgeAfter,
  type Actor,
  type IssueLifecycle,
  type LifecycleOutcome,
} from '@surface/domain';
import { ALL_OPERATIONS } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import { HANDLERS } from '../src/handlers/index.js';
import {
  createComment,
  deleteComment,
  setThreadResolved,
  updateComment,
  type CommentTarget,
  type CommentWriteContext,
} from '../src/handlers/comments/core.js';
import { createIssue, updateIssue, type IssueRow } from '../src/handlers/issues/core.js';
import type { Repo } from '../src/sync/repo.js';
import { deleteIssue, restoreIssue } from '../src/handlers/issues/lifecycle-core.js';
import { memoryComments } from './support/memory-comments.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';
import { recordingDb, scriptedDb, type Statement } from './support/scripted-db.js';

const EARLIER = new Date('2026-10-01T00:00:00.000Z');
const DELETED_AT = new Date(NOW.getTime() - 60 * 60 * 1000);

/** ENG-1 in `state`, with the workspace's records cleared and every repo write logged in `calls`. */
async function issueIn(state: IssueLifecycle): Promise<{ m: MemoryIssues; issue: IssueRow }> {
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
    archivedAt: state === 'archived' ? EARLIER : null,
    deletedAt: state === 'deleted' ? DELETED_AT : null,
    deletedById: state === 'deleted' ? ADA_ID : null,
    updatedAt: EARLIER,
  };
  m.issues.set(issue.id, issue);
  for (const list of [m.writes, m.events, m.calls, m.lockModes, m.history]) list.length = 0;
  // Every write lands in `calls` too, so a test can see that the lock came first.
  const repo = m.repo as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['insert', 'update', 'archive', 'unarchive', 'updateWhere', 'purge']) {
    const original = repo[name];
    if (typeof original !== 'function') continue;
    repo[name] = (...args: unknown[]) => {
      m.calls.push(`write:${name}`);
      return original(...args);
    };
  }
  return { m, issue };
}

/** Runs one operation's handler rules on `issue` at `now`. */
type Case = (m: MemoryIssues, issue: IssueRow, now: Date) => Promise<unknown>;

/**
 * A comment rule run on a thread of `issue` (a root by Ada with one reply, resolved when
 * `resolved`): the issue lock goes through `m`'s access, so `m` records its mode, and each comment
 * write is recorded in `m.writes` and `m.calls` like an issue write (PLAN-013 S3).
 */
function commentCase(
  rule: (ctx: CommentWriteContext, target: CommentTarget) => Promise<unknown>,
  options: { readonly resolved?: boolean } = {},
): Case {
  return (m, issue) => {
    const c = memoryComments();
    const root = c.addComment({
      issueId: issue.id,
      teamId: issue.teamId,
      userId: ADA_ID,
      ...(options.resolved === true ? { resolvedAt: EARLIER, resolvedById: ADA_ID } : {}),
    });
    c.addComment({ issueId: issue.id, teamId: issue.teamId, parentCommentId: root.id });
    const recorded = (method: 'insert' | 'update' | 'purge', model: string, id: string) => {
      m.calls.push(`write:${method}`);
      m.writes.push({
        action: method === 'insert' ? 'insert' : 'update',
        model,
        ids: [id],
        fields: [],
      });
    };
    const repo: Repo = {
      ...c.repo,
      insert: (model, row) => {
        recorded('insert', model, row.id ?? '');
        return c.repo.insert(model, row);
      },
      update: (model, id, patch) => {
        recorded('update', model, id);
        return c.repo.update(model, id, patch);
      },
      purge: (model, id) => {
        recorded('purge', model, id);
        return c.repo.purge(model, id);
      },
    };
    const base = c.ctx({ userId: ADA_ID });
    const ctx: CommentWriteContext = {
      ...base,
      repo,
      emit: (event) => void m.events.push(event),
      access: { ...base.access, lockIssue: (id, mode) => m.ctx.access.lockIssue(id, mode) },
    };
    return rule(ctx, { commentId: root.id, issueId: issue.id, rootId: root.id });
  };
}

const commentBody = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }],
};

/** One case per built row: the handler's own rules, as its handler calls them. */
const CASES: Readonly<Record<string, Case>> = {
  'issue.update': (m, issue) =>
    updateIssue(m.ctx, {
      issueId: issue.id,
      teamId: issue.teamId,
      title: 'Fix the login',
      addLabelIds: [],
      removeLabelIds: [],
    }),
  'issue.delete': (m, issue, now) => deleteIssue(m.lifecycle({ now }), issue.id),
  'issue.restore': (m, issue, now) => restoreIssue(m.lifecycle({ now }), issue.id),
  'comment.create': commentCase((ctx, t) =>
    createComment(ctx, { id: randomUUID(), issueId: t.issueId, body: commentBody }),
  ),
  'comment.update': commentCase((ctx, t) =>
    updateComment(ctx, { ...t, baseVersion: 1, body: commentBody }),
  ),
  // The root has a reply, so this is a soft delete: an update.
  'comment.delete': commentCase((ctx, t) => deleteComment(ctx, t)),
  'comment.resolve': commentCase((ctx, t) => setThreadResolved(ctx, t, true)),
  'comment.reopen': commentCase((ctx, t) => setThreadResolved(ctx, t, false), { resolved: true }),
};

/** What happened, in the table's words. */
function outcome(
  before: IssueRow,
  after: IssueRow | undefined,
  error: unknown,
  wrote: boolean,
): LifecycleOutcome | 'error' {
  if (error instanceof SurfaceError && error.code === 'CONFLICT') return 'conflict';
  if (error !== undefined) return 'error';
  if (after === undefined) return 'toPurged';
  if (!wrote) return 'noop';
  const state = (row: IssueRow): IssueLifecycle =>
    row.deletedAt !== null ? 'deleted' : row.archivedAt !== null ? 'archived' : 'live';
  if (state(after) === state(before)) return 'applies';
  return state(after) === 'live'
    ? 'toLive'
    : state(after) === 'deleted'
      ? 'toDeleted'
      : 'toArchived';
}

async function run(name: string, state: IssueLifecycle, now = NOW) {
  const { m, issue } = await issueIn(state);
  const cases = CASES[name];
  if (cases === undefined) throw new Error(`no case for ${name}`);
  let error: unknown;
  await cases(m, issue, now).catch((e: unknown) => {
    error = e;
  });
  const wrote = m.writes.length > 0;
  return { m, issue, error, result: outcome(issue, m.issues.get(issue.id), error, wrote) };
}

const rows = Object.entries(ISSUE_LIFECYCLE_RULES);
const built = rows.filter(([, rule]) => rule.pending === undefined);

describe('the lifecycle rule table, row by row (AC-1, AC-2)', () => {
  it('lists every row whose handler is not built yet as pending, with the slice that adds it', () => {
    const pending = Object.fromEntries(
      rows.flatMap(([name, rule]) => (rule.pending === undefined ? [] : [[name, rule.pending]])),
    );
    expect(pending).toEqual({
      'issue.updateDescription': 'PLAN-011 S6',
      'reaction.set': 'PLAN-013 S4',
      'attachment.createFile': 'PLAN-014 S4a',
      'attachment.createLink': 'PLAN-014 S4a',
      'attachment.update': 'PLAN-014 S4a',
      'attachment.delete': 'PLAN-014 S4a',
      'issue.purge': 'PLAN-015 S2',
      'label.delete': 'PLAN-010 S5',
      'attachment.setPreview': 'PLAN-014 S4b',
      'files-cleanup': 'PLAN-014 S4a',
      'trash-purge': 'PLAN-015 S2',
      'issue.autoArchive': 'PLAN-015 S3',
      'issue.autoClose': 'PLAN-015 S3',
    });
  });

  it('has a case for every built row, and each names a registered operation with a handler', () => {
    const handled = new Set(HANDLERS.map((h) => h.op.name));
    for (const [name, rule] of built) {
      expect(CASES[name], `${name} is built but has no case here`).toBeDefined();
      if (rule.kind === 'operation') expect(handled.has(name), name).toBe(true);
    }
  });

  it('has a row for every mutation that names an issue', () => {
    const named = ALL_OPERATIONS.filter((op) => {
      if (op.kind !== 'mutation' || !(op.input instanceof z.ZodObject)) return false;
      return Object.keys(op.input.shape).includes('issue');
    }).map((op) => op.name);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(ISSUE_LIFECYCLE_RULES[name], name).toBeDefined();
  });

  describe.each(built)('%s', (name, rule) => {
    it.each(ISSUE_LIFECYCLES)(
      'locks in its mode before any write and gives the listed result on a %s issue',
      async (state) => {
        const { m, result } = await run(name, state);
        expect(m.lockModes[0]).toBe(rule.mode);
        const firstWrite = m.calls.findIndex((c) => c.startsWith('write:'));
        if (firstWrite >= 0) expect(m.calls.indexOf('lockIssue')).toBeLessThan(firstWrite);
        const listed = rule[state];
        // Before purgeAfter (now) a deleted issue is restored; the boundary case follows.
        expect(result).toBe(listed === 'toLiveBeforePurgeAfter' ? 'toLive' : listed);
        if (result === 'conflict' || result === 'noop') {
          expect(m.writes).toEqual([]);
          expect(m.events).toEqual([]);
          expect(m.history).toEqual([]);
        }
      },
    );
  });

  it('restores a deleted issue only before purgeAfter', async () => {
    const at = await run('issue.restore', 'deleted', purgeAfter(DELETED_AT));
    expect(at.result).toBe('conflict');
  });

  it.each([
    ['archived', 'ENG-1 is archived. Restore it to edit it.'],
    ['deleted', 'ENG-1 was deleted. Restore it to edit it.'],
  ] as const)(
    'refuses a direct edit of a %s issue with the §4.2 wording (AC-2)',
    async (state, message) => {
      const { error } = await run('issue.update', state);
      expect(error).toBeInstanceOf(SurfaceError);
      expect(error instanceof SurfaceError && error.message).toBe(message);
    },
  );
});

/** The comment the comment handlers' inputs name, a top-level comment on ENG-1 by Ada. */
const COMMENT_ID = '0190f0c0-0000-7000-8000-0000000000c1';

/** The input each built operation's registered handler runs with on ENG-1. */
const HANDLER_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  'issue.update': { issue: 'ENG-1', title: 'Fix the login' },
  'issue.delete': { issue: 'ENG-1' },
  'issue.restore': { issue: 'ENG-1' },
  'comment.create': { issue: 'ENG-1', body: 'Looks good' },
  'comment.update': { comment: COMMENT_ID, baseVersion: 1, body: 'Looks good' },
  'comment.delete': { comment: COMMENT_ID },
  'comment.resolve': { comment: COMMENT_ID },
  'comment.reopen': { comment: COMMENT_ID },
};

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [snake(key), value]));

/**
 * Answers a plain `select "a", "b" from "table" …` with the fixture row of `table`, in the
 * selected columns' order; anything else gets no rows.
 */
function answerFrom(tables: Readonly<Record<string, Record<string, unknown>>>) {
  return (text: string): unknown[][] => {
    const match = /^select (.+?) from "(\w+)"/.exec(text);
    const row = match?.[2] === undefined ? undefined : tables[match[2]];
    if (match?.[1] === undefined || row === undefined) return [];
    const columns = match[1].split(', ').map((column) => column.replace(/^.*"(\w+)"$/, '$1'));
    return [columns.map((column) => row[column] ?? null)];
  };
}

/**
 * Runs `name`'s registered handler on ENG-1 in `state`, over a connection that records its SQL
 * and a repo that records each write in the same list (as `repo.<method>`).
 */
async function runHandler(name: string, state: IssueLifecycle): Promise<Statement[]> {
  const { m, issue } = await issueIn(state);
  const found = HANDLERS.find((h) => h.op.name === name);
  if (found === undefined) throw new Error(`no handler for ${name}`);
  const team = { ...NEW_TEAM_SETTINGS, ...m.eng, defaultStatusId: issue.statusId };
  const { db, statements } = recordingDb(
    answerFrom({
      issues: snakeRow(issue),
      teams: snakeRow(team),
      workflow_statuses: { id: issue.statusId, name: 'Backlog', category: 'backlog' },
      users: { id: ADA_ID, name: 'Ada' },
      comments: snakeRow({
        id: COMMENT_ID,
        issueId: issue.id,
        teamId: issue.teamId,
        parentCommentId: null,
        userId: ADA_ID,
        actorKind: 'user',
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
        version: 1,
        editedAt: null,
        deletedAt: null,
        resolvedAt: null,
        resolvedById: null,
        syncGroups: [`team:${issue.teamId}`],
        createdAt: EARLIER,
        updatedAt: EARLIER,
      }),
    }),
  );
  let current: IssueRow = issue;
  const write = (method: string, patch: Partial<IssueRow> = {}) => {
    statements.push({ text: `repo.${method}`, params: [] });
    current = { ...current, ...patch };
    return Promise.resolve(current);
  };
  const repo = {
    update: (_model: string, _id: string, patch: Partial<IssueRow>) => write('update', patch),
    archive: () => write('archive', { archivedAt: NOW }),
    unarchive: () => write('unarchive', { archivedAt: null }),
    updateWhere: () => write('updateWhere').then(() => []),
    insert: () => write('insert'),
    purge: () => write('purge'),
    deleteWhere: () => write('deleteWhere').then(() => []),
  };
  const actor: Actor = {
    kind: 'user',
    userId: ADA_ID,
    groups: ['workspace', `user:${ADA_ID}`],
    publicTeams: [issue.teamId],
    memberOf: [issue.teamId],
  };
  // Only what these handlers touch; the executor resolved the `IssueRef` (step 7).
  const ctx = {
    actor,
    tx: db,
    repo,
    refs: {
      issue: { id: issue.id, teamId: issue.teamId, key: 'ENG-1' },
      comment: { id: COMMENT_ID, issueId: issue.id, teamId: issue.teamId, parentCommentId: null },
    },
    now: () => NOW,
    emit: () => undefined,
    publicUrl: 'https://surface.test',
  } as unknown as HandlerContext;
  const input = found.op.input.parse(HANDLER_INPUTS[name]);
  // A refusal or a no-op is part of the row; only the order of statements is checked here.
  await found.run(ctx, input).catch(() => undefined);
  return statements;
}

describe('each built row’s registered handler locks the issue first (AC-1, SPEC-011 §4.8)', () => {
  it('has a handler input for every built operation row', () => {
    for (const [name, rule] of built) {
      if (rule.kind === 'operation') expect(HANDLER_INPUTS[name], name).toBeDefined();
    }
  });

  describe.each(built.filter(([, rule]) => rule.kind === 'operation'))('%s', (name) => {
    it.each(ISSUE_LIFECYCLES)(
      'takes the issue row lock before reading the issue otherwise or writing (%s issue)',
      async (state) => {
        const statements = await runHandler(name, state);
        const texts = statements.map((statement) => statement.text);
        const lock = texts.findIndex((text) => text.includes('from "issues"'));
        expect(lock, texts.join('\n')).toBeGreaterThanOrEqual(0);
        expect(texts[lock]).toMatch(/^select .* from "issues" where .* for update$/);
        const firstWrite = texts.findIndex((text) => text.startsWith('repo.'));
        if (firstWrite >= 0) expect(lock).toBeLessThan(firstWrite);
      },
    );
  });
});

describe('cascades write archived and deleted issues and keep their state (AC-2, E11)', () => {
  it('a label removal through updateWhere leaves lifecycle and updatedAt alone', async () => {
    const LABEL = '0190f0c0-0000-7000-8000-0000000000b1';
    const OTHER = '0190f0c0-0000-7000-8000-0000000000b2';
    const row = (id: string, archivedAt: Date | null, deletedAt: Date | null) => ({
      id,
      label_ids: [LABEL, OTHER],
      archived_at: archivedAt,
      deleted_at: deletedAt,
      updated_at: EARLIER,
      sync_groups: ['team:eng'],
    });
    const ARCHIVED = '0190f0c0-0000-7000-8000-000000000001';
    const DELETED = '0190f0c0-0000-7000-8000-000000000002';
    const { repo, rowsOf } = scriptedDb(
      { issues: [row(ARCHIVED, EARLIER, null), row(DELETED, null, DELETED_AT)] },
      { now: NOW },
    );
    // `label.delete`'s cascade (`removeLabelFromIssues`) computes the array in SQL; the stand-in
    // database here takes a plain value, which is all the lifecycle rule is about.
    await repo.updateWhere(
      'Issue',
      [ARCHIVED, DELETED],
      { labelIds: [OTHER] },
      {
        touchUpdatedAt: false,
      },
    );
    expect(rowsOf('issues').get(ARCHIVED)).toMatchObject({
      // Drizzle sends the array as a Postgres array literal.
      label_ids: `{"${OTHER}"}`,
      archived_at: EARLIER,
      deleted_at: null,
      updated_at: EARLIER,
    });
    expect(rowsOf('issues').get(DELETED)).toMatchObject({
      label_ids: `{"${OTHER}"}`,
      archived_at: null,
      deleted_at: DELETED_AT,
      updated_at: EARLIER,
    });
    expect(repo.changes().map((c) => [c.action, c.id])).toEqual([
      ['U', ARCHIVED],
      ['U', DELETED],
    ]);
  });
});
