// PLAN-015 S1, SPEC-015 §4.3–§4.4: AC-1 (every row of the lifecycle rule table holds: the
// operation's handler locks the issue in the row's mode, before any write, and gets the listed
// result for a live, an archived and a deleted issue), AC-2 (direct edits of archived and deleted
// issues are CONFLICT with the §4.2 wording and no repo write; cascades write archived and deleted
// issues and leave their lifecycle and `updatedAt` alone: E11), E15's refusal wording. A row whose
// handler doesn't exist yet is listed as pending, by the slice that adds it; a built row with no
// case here fails, and so does an issue mutation with no row.
import { randomUUID } from 'node:crypto';
import {
  ISSUE_LIFECYCLE_RULES,
  ISSUE_LIFECYCLES,
  purgeAfter,
  type IssueLifecycle,
  type LifecycleOutcome,
} from '@surface/domain';
import { ALL_OPERATIONS } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SurfaceError } from '../src/executor/errors.js';
import { HANDLERS } from '../src/handlers/index.js';
import { createIssue, updateIssue, type IssueRow } from '../src/handlers/issues/core.js';
import { deleteIssue, restoreIssue } from '../src/handlers/issues/lifecycle-core.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';
import { scriptedDb } from './support/scripted-db.js';

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
      'comment.create': 'PLAN-013 S3',
      'comment.update': 'PLAN-013 S3',
      'comment.delete': 'PLAN-013 S3',
      'comment.resolve': 'PLAN-013 S3',
      'comment.reopen': 'PLAN-013 S3',
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
