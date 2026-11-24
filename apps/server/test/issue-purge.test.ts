// PLAN-015 S2, SPEC-015 §4.5: AC-4 (the cascade plan: every purge step, then the Issue with a
// logged `D`; content rows unlogged; the team counter kept), AC-10's purge part (Admin only; an
// API key needs "allow destructive"), E6 (a failed step leaves the issue), E16 (the issue lock
// comes before every step, so no child can appear behind one), and the audit line and event.
// `purge-steps.test.ts` checks the registry itself; the bytes (AC-5, E7, E8) arrive with PLAN-014
// S4a's file step and `purge-bytes.test.ts`.
import { randomUUID } from 'node:crypto';
import { bindPredicates, systemActor, userActor, type Actor } from '@surface/domain';
import { issuePurge } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import { keyScopeProblem } from '../src/executor/key-scope.js';
import { HANDLERS } from '../src/handlers/index.js';
import { createIssue, type IssueRow } from '../src/handlers/issues/core.js';
import { purgeIssue } from '../src/issues/purge.js';
import { PURGE_STEPS, type PurgeStep } from '../src/issues/purge-steps.js';
import {
  ADA_ACTOR,
  ADA_ID,
  memoryIssues,
  NOW,
  type MemoryIssues,
} from './support/memory-issues.js';
import { recordingDb, scriptedDb } from './support/scripted-db.js';

const EARLIER = new Date('2026-10-01T00:00:00.000Z');
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
/** `purgeAfter(DELETED_AT)`: from here on the job may purge it. */
const DUE = new Date('2026-12-01T00:00:00.000Z');

/** ENG-1, in `state`, and a fresh record of writes. */
async function issueIn(state: 'live' | 'archived' | 'deleted' | 'archivedAndDeleted'): Promise<{
  m: MemoryIssues;
  issue: IssueRow;
}> {
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
  const deleted = state === 'deleted' || state === 'archivedAndDeleted';
  const issue: IssueRow = {
    ...created,
    archivedAt: state === 'archived' || state === 'archivedAndDeleted' ? EARLIER : null,
    deletedAt: deleted ? DELETED_AT : null,
    deletedById: deleted ? ADA_ID : null,
  };
  m.issues.set(issue.id, issue);
  for (const list of [m.writes, m.events, m.calls, m.lockModes]) list.length = 0;
  return { m, issue };
}

/** Steps that record their order (and the issue lock's) in `m.calls`. */
function recordingSteps(m: MemoryIssues, models: readonly string[]): PurgeStep[] {
  return models.map((model) => ({
    model: `table:${model}`,
    step: (_tx, _repo, issueId) => {
      m.calls.push(`step:${model}:${issueId}`);
      return Promise.resolve();
    },
  }));
}

describe('issue.purge on a deleted issue (AC-4)', () => {
  it('runs every step, then deletes the Issue, under the issue lock taken first (E16)', async () => {
    const { m, issue } = await issueIn('deleted');
    const steps = recordingSteps(m, ['reactions', 'comments', 'history']);
    await purgeIssue(m.purge({ steps }), issue.id);
    expect(m.lockModes).toEqual(['lifecycle']);
    expect(m.calls).toEqual([
      'lockIssue',
      `step:reactions:${issue.id}`,
      `step:comments:${issue.id}`,
      `step:history:${issue.id}`,
    ]);
    expect(m.writes).toEqual([{ action: 'purge', ids: [issue.id], fields: [] }]);
    expect(m.issues.has(issue.id)).toBe(false);
  });

  it('purges an issue that is archived as well as deleted', async () => {
    const { m, issue } = await issueIn('archivedAndDeleted');
    await purgeIssue(m.purge(), issue.id);
    expect(m.issues.has(issue.id)).toBe(false);
  });

  it('runs the registered steps: content rows unlogged (ADR-0022), with the issue’s own rows only', async () => {
    const { m, issue } = await issueIn('deleted');
    await purgeIssue(m.purge({ steps: PURGE_STEPS }), issue.id);
    const deletes = m.writes.filter((w) => w.action === 'deleteWhere');
    expect(deletes.map((w) => w.model)).toEqual([
      'Reaction',
      'Comment',
      'Attachment',
      'IssueHistory',
      'IssueContent',
    ]);
    for (const write of deletes) {
      // Content rows unlogged; Attachment rows are logged, one `D` each (PLAN-014 S4a), so the
      // client drops them even if it missed the Issue's.
      const log = write.model === 'Attachment';
      expect(write).toMatchObject({ ids: [issue.id], fields: ['issueId'], log });
    }
    // The Issue's own delete comes last, and is the one logged write.
    expect(m.writes.at(-1)).toEqual({ action: 'purge', ids: [issue.id], fields: [] });
  });

  it('writes the audit line without the title and emits issue.purged; no history (§4.5, §4.8)', async () => {
    const { m, issue } = await issueIn('deleted');
    await purgeIssue(m.purge(), issue.id);
    expect(m.audits).toEqual([
      {
        event: 'issue.purged',
        fields: { issueId: issue.id, teamId: m.eng.id, number: 1, actorId: ADA_ID },
        message: 'issue purged',
      },
    ]);
    expect(JSON.stringify(m.audits)).not.toContain('Fix login');
    expect(m.events).toEqual([
      {
        type: 'issue.purged',
        subject: { type: 'issue', id: issue.id },
        data: { teamId: m.eng.id, number: 1 },
      },
    ]);
    expect(m.history).toEqual([]);
  });

  it('names no actor in the audit line when the job purges (the system actor)', async () => {
    const { m, issue } = await issueIn('deleted');
    await purgeIssue(m.purge({ actor: systemActor(), now: DUE }), issue.id);
    expect(m.audits[0]?.fields).toEqual({ issueId: issue.id, teamId: m.eng.id, number: 1 });
  });

  it('lets an Admin purge before the 720 h are up: an Admin’s purge has no time limit', async () => {
    const { m, issue } = await issueIn('deleted');
    await purgeIssue(m.purge({ now: new Date(DELETED_AT.getTime() + 1000) }), issue.id);
    expect(m.issues.has(issue.id)).toBe(false);
  });

  it('keeps the team counter, so the number is never reused (INV-08)', async () => {
    const { m, issue } = await issueIn('deleted');
    await purgeIssue(m.purge(), issue.id);
    const next = await createIssue(m.ctx, {
      id: randomUUID(),
      team: m.eng,
      teamRef: 'ENG',
      title: 'Next',
      assigneeId: null,
      labelIds: [],
      estimate: null,
      dueDate: null,
      creatorId: ADA_ID,
    });
    expect(next.number).toBe(2);
  });
});

describe('issue.purge refuses', () => {
  it.each(['live', 'archived'] as const)(
    'a %s issue with CONFLICT "Delete ENG-1 first.", running no step and writing nothing',
    async (state) => {
      const { m, issue } = await issueIn(state);
      const steps = recordingSteps(m, ['comments']);
      const error = await purgeIssue(m.purge({ steps }), issue.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SurfaceError);
      expect(error).toMatchObject({ code: 'CONFLICT', message: 'Delete ENG-1 first.' });
      expect(m.calls).toEqual(['lockIssue']);
      expect(m.writes).toEqual([]);
      expect(m.events).toEqual([]);
      expect(m.audits).toEqual([]);
      expect(m.issues.has(issue.id)).toBe(true);
    },
  );

  it('an issue that is gone with NOT_FOUND, like one that never existed (the job counts it done)', async () => {
    const { m } = await issueIn('deleted');
    const error = await purgeIssue(m.purge(), randomUUID()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect(m.writes).toEqual([]);
  });

  it('for the job, a deleted issue not yet due with CONFLICT, re-checked under the lock (D20)', async () => {
    const { m, issue } = await issueIn('deleted');
    const steps = recordingSteps(m, ['comments']);
    const justBefore = new Date(DUE.getTime() - 1);
    const error = await purgeIssue(
      m.purge({ actor: systemActor(), now: justBefore, steps }),
      issue.id,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(m.calls).toEqual(['lockIssue']);
    expect(m.writes).toEqual([]);
    expect(m.audits).toEqual([]);
    expect(m.issues.has(issue.id)).toBe(true);
    // At exactly `purgeAfter` it is due (§4.2).
    await purgeIssue(m.purge({ actor: systemActor(), now: DUE, steps }), issue.id);
    expect(m.issues.has(issue.id)).toBe(false);
  });

  it('stops at a failing step: no Issue delete, audit line or event follows it (E6)', async () => {
    // Undoing the steps that ran is the executor's job: the whole operation is one transaction,
    // which rolls back when purgeIssue throws, so the next run finds the issue as it was.
    const { m, issue } = await issueIn('deleted');
    const failing: PurgeStep = {
      model: 'table:broken',
      step: () => Promise.reject(new Error('connection lost')),
    };
    const writing: PurgeStep = {
      model: 'IssueHistory',
      step: async (_tx, repo, issueId) => {
        await repo.deleteWhere('IssueHistory', 'issueId', [issueId], { log: false });
      },
    };
    await expect(purgeIssue(m.purge({ steps: [writing, failing] }), issue.id)).rejects.toThrow(
      'connection lost',
    );
    // The first step's write, and nothing after the failure: no `purge Issue`.
    expect(m.writes).toEqual([
      {
        action: 'deleteWhere',
        model: 'IssueHistory',
        ids: [issue.id],
        fields: ['issueId'],
        log: false,
      },
    ]);
    expect(m.events).toEqual([]);
    expect(m.audits).toEqual([]);
    expect(m.issues.has(issue.id)).toBe(true);
  });
});

describe('who may purge (§5.3, AC-10)', () => {
  const key = (allowDestructive: boolean, scope: 'read' | 'read_write' = 'read_write'): Actor => ({
    ...ADA_ACTOR,
    kind: 'api',
    role: 'admin',
    apiKey: { id: 'key-1', scope, teamIds: [], allowDestructive },
  });

  it('is Admin only: a Member is refused, an Admin and the system actor pass', () => {
    const allowed = (actor: Actor) =>
      issuePurge.permission(bindPredicates(actor).p, {}, { issue: 'ENG-1' });
    expect(allowed(userActor({ userId: ADA_ID, role: 'member', memberships: [] }))).toBe(false);
    expect(allowed(userActor({ userId: ADA_ID, role: 'admin', memberships: [] }))).toBe(true);
    expect(allowed(systemActor())).toBe(true);
  });

  it('needs an API key with "allow destructive", and read-write', () => {
    expect(keyScopeProblem(issuePurge, key(false))).toMatch(/allow destructive/);
    expect(keyScopeProblem(issuePurge, key(true, 'read'))).toMatch(/read-only/);
    expect(keyScopeProblem(issuePurge, key(true))).toBeUndefined();
  });
});

describe('the issue.purge handler on SQL', () => {
  /** Runs the registered handler on a deleted ENG-1 over a recording connection. */
  async function run() {
    const { m, issue } = await issueIn('deleted');
    const columns: Record<string, unknown> = {
      id: issue.id,
      team_id: issue.teamId,
      number: issue.number,
      archived_at: null,
      deleted_at: DELETED_AT,
      sync_groups: [`team:${issue.teamId}`],
    };
    const { db, statements } = recordingDb((text) => {
      const match = /^select (.+?) from "issues"/.exec(text);
      if (match?.[1] === undefined) return [];
      const names = match[1].split(', ').map((c) => c.replace(/^.*"(\w+)"$/, '$1'));
      return [names.map((name) => columns[name] ?? null)];
    });
    const writes: string[] = [];
    const audits: string[] = [];
    const ctx = {
      actor: ADA_ACTOR,
      tx: db,
      repo: {
        deleteWhere: (
          model: string,
          _field: string,
          _ids: string[],
          options?: { log?: boolean },
        ) => {
          writes.push(`deleteWhere ${model} log=${String(options?.log ?? true)}`);
          return Promise.resolve([]);
        },
        purge: (model: string) => {
          writes.push(`purge ${model}`);
          return Promise.resolve();
        },
      },
      refs: { issue: { id: issue.id, teamId: issue.teamId, key: 'ENG-1' } },
      now: () => NOW,
      emit: () => undefined,
      audit: (event: string) => void audits.push(event),
      publicUrl: 'https://surface.test',
    } as unknown as HandlerContext;
    const found = HANDLERS.find((h) => h.op.name === 'issue.purge');
    if (found === undefined) throw new Error('issue.purge has no handler');
    const output = await found.run(ctx, found.op.input.parse({ issue: 'ENG-1' }));
    return { m, output, texts: statements.map((s) => s.text), writes, audits };
  }

  it('locks the issue first, runs the steps, deletes the Issue, and never touches the team row', async () => {
    const { output, texts, writes, audits } = await run();
    expect(output).toEqual({ purged: true });
    expect(texts[0]).toMatch(/^select .* from "issues" where .* for update$/);
    // The team's counter lives on its row: a purge neither reads nor writes it (INV-08).
    expect(texts.some((t) => t.includes('"teams"') || /\bteams\b/.test(t))).toBe(false);
    expect(writes).toEqual([
      'deleteWhere Reaction log=false',
      'deleteWhere Comment log=false',
      'deleteWhere Attachment log=true',
      'deleteWhere IssueHistory log=false',
      'deleteWhere IssueContent log=false',
      'purge Issue',
    ]);
    expect(audits).toEqual(['issue.purged']);
  });
});

describe('the purge on the real repo (AC-4: D counts)', () => {
  it('logs one D for the Issue and each Attachment, none for its content rows, and flush accepts it', async () => {
    const ISSUE = '0190f0c0-0000-7000-8000-000000000042';
    const TEAM = '0190f0c0-0000-7000-8000-0000000000e1';
    const groups = [`team:${TEAM}`];
    const child = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      issue_id: ISSUE,
      team_id: TEAM,
      sync_groups: groups,
      ...extra,
    });
    const id = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
    const { db, repo, rowsOf } = scriptedDb(
      {
        issues: [{ id: ISSUE, team_id: TEAM, deleted_at: DELETED_AT, sync_groups: groups }],
        reactions: [child(id(1), { comment_id: id(2) })],
        comments: [
          child(id(2), { parent_comment_id: null }),
          child(id(3), { parent_comment_id: id(2) }),
        ],
        issue_history: [child(id(4)), child(id(5))],
        issue_content: [child(ISSUE)],
        attachments: [child(id(6)), child(id(7))],
      },
      { now: NOW, restrict: [{ table: 'comments', column: 'parent_comment_id' }] },
    );
    const m = memoryIssues();
    // The lock is the memory one; the steps and the Issue delete run on the scripted tables.
    const locked = {
      ...[...m.issues.values()][0],
      id: ISSUE,
      teamId: TEAM,
      number: 42,
      archivedAt: null,
      deletedAt: DELETED_AT,
    } as unknown as IssueRow;
    m.issues.set(ISSUE, locked);
    // The server-only search-text step is plain SQL this stand-in doesn't answer; it is
    // `comment-purge-step.test.ts`'s.
    const steps = PURGE_STEPS.filter((s) => !s.model.startsWith('table:'));
    await purgeIssue({ ...m.purge({ steps }), tx: db, repo }, ISSUE);
    for (const table of [
      'issues',
      'reactions',
      'comments',
      'attachments',
      'issue_history',
      'issue_content',
    ]) {
      expect(rowsOf(table).size, table).toBe(0);
    }
    expect(repo.changes().map((c) => [c.action, c.model, c.id])).toEqual([
      ['D', 'Attachment', id(6)],
      ['D', 'Attachment', id(7)],
      ['D', 'Issue', ISSUE],
    ]);
    expect(repo.unloggedDeletes().map((u) => [u.model, u.ids.length])).toEqual([
      ['Reaction', 1],
      ['Comment', 2],
      ['IssueHistory', 2],
      ['IssueContent', 1],
    ]);
    const flushed = await repo.flush({});
    expect(typeof flushed.lastSyncId).toBe('number');
  });
});
