// PLAN-011 S3, SPEC-011 §4.8 and §6.4, SPEC-015 §4.3–§4.4, AC-23 (unit part): `lockIssueForWrite`.
// `edit` refuses archived and deleted issues with the §6.4 wording before anything is written
// (so even a no-op edit is refused); `cascade` and `lifecycle` pass and return the state; a
// missing, invisible or key-excluded issue is `NOT_FOUND`, worded like an `IssueRef` that matches
// nothing (E13). The visibility filter itself runs in Postgres (held, plans README §6); here we
// check the SQL carries it.
import type { Actor } from '@surface/domain';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { issues } from '../src/db/schema/index.js';
import { SurfaceError } from '../src/executor/errors.js';
import { refNotFound } from '../src/executor/refs/resolve.js';
import { lockIssueForWrite, type IssueLockMode } from '../src/issues/lifecycle.js';
import { recordingDb } from './support/scripted-db.js';

const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const OPS = '0190f0c0-0000-7000-8000-00000000f000';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const AT = '2026-11-01T09:00:00.000Z';

const ada: Actor = {
  kind: 'user',
  userId: ADA,
  groups: ['workspace', `user:${ADA}`],
  memberOf: [ENG],
};
const system: Actor = { kind: 'system', groups: [], memberOf: [] };

type State = { readonly archivedAt: string | null; readonly deletedAt: string | null };
const LIVE: State = { archivedAt: null, deletedAt: null };
const ARCHIVED: State = { archivedAt: AT, deletedAt: null };
const DELETED: State = { archivedAt: null, deletedAt: AT };
const ARCHIVED_AND_DELETED: State = { archivedAt: AT, deletedAt: AT };

/** The issue row as `select *` returns it: one value per column, in the table's order. */
function issueRow(state: State): unknown[] {
  const row: Record<string, unknown> = {
    id: ISSUE,
    teamId: ENG,
    number: 42,
    title: 'Fix login',
    statusId: '0190f0c0-0000-7000-8000-000000000051',
    priority: 0,
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    sortOrder: 'a0V001',
    creatorId: ADA,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: state.archivedAt,
    deletedAt: state.deletedAt,
    deletedById: state.deletedAt === null ? null : ADA,
    syncGroups: ['workspace'],
    createdAt: AT,
    updatedAt: AT,
  };
  return Object.keys(getTableColumns(issues)).map((column) => row[column]);
}

/** A connection holding one issue (or none, when it is missing or invisible) and team ENG. */
function connection(state: State | undefined) {
  return recordingDb((text) => {
    if (text.includes('from "issues"')) return state === undefined ? [] : [issueRow(state)];
    if (text.includes('from "teams"')) return [['ENG']];
    return [];
  });
}

async function refusal(promise: Promise<unknown>): Promise<SurfaceError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SurfaceError))
    throw new Error(`expected a SurfaceError, got ${String(error)}`);
  return error;
}

describe('lockIssueForWrite', () => {
  it('locks the issue row FOR UPDATE and returns it with its state', async () => {
    const { db, statements } = connection(LIVE);
    const locked = await lockIssueForWrite(db, ISSUE, { actor: ada }, 'edit');
    expect(locked).toMatchObject({ id: ISSUE, teamId: ENG, number: 42, state: 'live' });
    expect(locked.syncGroups).toEqual(['workspace']);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toMatch(/^select .* from "issues" where .* for update$/);
    expect(statements[0]?.params[0]).toBe(ISSUE);
  });

  it.each([
    [ARCHIVED, 'ENG-42 is archived. Restore it to edit it.'],
    [DELETED, 'ENG-42 was deleted. Restore it to edit it.'],
    [ARCHIVED_AND_DELETED, 'ENG-42 was deleted. Restore it to edit it.'],
  ])('refuses an edit of a %o issue with CONFLICT and the §6.4 wording', async (state, message) => {
    const { db, statements } = connection(state);
    const error = await refusal(lockIssueForWrite(db, ISSUE, { actor: ada }, 'edit'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(message);
    // Refused at the lock, before the handler could compare or write anything: a no-op edit is
    // refused the same way (E12). Only the identifier's team key is read, without a lock.
    expect(statements.map(({ text }) => text.split(' where ')[0])).toEqual([
      expect.stringMatching(/^select .* from "issues"$/),
      'select "key" from "teams"',
    ]);
    expect(statements[1]?.text).not.toMatch(/for (update|share)/);
  });

  it.each<[IssueLockMode, State, string]>([
    ['cascade', ARCHIVED, 'archived'],
    ['cascade', DELETED, 'deleted'],
    ['cascade', LIVE, 'live'],
    ['lifecycle', ARCHIVED, 'archived'],
    ['lifecycle', ARCHIVED_AND_DELETED, 'deleted'],
    ['lifecycle', LIVE, 'live'],
  ])('lets %s mode lock a %o issue and returns its state', async (mode, state, expected) => {
    const { db, statements } = connection(state);
    const locked = await lockIssueForWrite(db, ISSUE, { actor: system }, mode);
    expect(locked.state).toBe(expected);
    // Neither mode changes lifecycle state: the row comes back as stored.
    expect(locked.archivedAt?.toISOString() ?? null).toBe(state.archivedAt);
    expect(locked.deletedAt?.toISOString() ?? null).toBe(state.deletedAt);
    expect(statements).toHaveLength(1);
  });

  it.each<IssueLockMode>(['edit', 'lifecycle', 'cascade'])(
    'answers NOT_FOUND, worded like an IssueRef, for an issue it cannot see (%s)',
    async (mode) => {
      const { db } = connection(undefined);
      const error = await refusal(lockIssueForWrite(db, ISSUE, { actor: ada }, mode));
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe(refNotFound('IssueRef', ISSUE, ['issue']).message);
      expect(error.message).toBe(
        `Issue "${ISSUE}" not found. Use an issue identifier like ENG-123, or an issue id.`,
      );
    },
  );

  it('names the input path the caller gives in its NOT_FOUND', async () => {
    const { db } = connection(undefined);
    const error = await refusal(
      lockIssueForWrite(db, ISSUE, { actor: ada, path: ['issues', 2] }, 'edit'),
    );
    expect(error.details.issues?.[0]?.path).toEqual(['issues', 2]);
    const fallback = await refusal(
      lockIssueForWrite(connection(undefined).db, ISSUE, { actor: ada }, 'edit'),
    );
    expect(fallback.details.issues?.[0]?.path).toEqual(['issue']);
  });

  it("filters by the actor's sync groups in SQL", async () => {
    const { db, statements } = connection(LIVE);
    await lockIssueForWrite(db, ISSUE, { actor: ada }, 'edit');
    expect(statements[0]?.text).toContain('"issues"."sync_groups" && $2');
    // Drizzle sends the array as a Postgres array literal.
    expect(statements[0]?.params[1]).toBe(`{"workspace","user:${ADA}"}`);
    expect(statements[0]?.text).not.toContain('"issues"."team_id" in');
  });

  it("filters by an API key's teams in SQL, so a public team outside them is NOT_FOUND", async () => {
    const keyed: Actor = {
      ...ada,
      kind: 'api',
      apiKey: { id: 'key-1', scope: 'read_write', teamIds: [OPS], allowDestructive: false },
    };
    const { db, statements } = connection(LIVE);
    await lockIssueForWrite(db, ISSUE, { actor: keyed }, 'edit');
    expect(statements[0]?.text).toContain('"issues"."team_id" in ($3)');
    expect(statements[0]?.params[2]).toBe(OPS);
  });

  it('applies no visibility filter for the system actor (permissions.md §1)', async () => {
    const { db, statements } = connection(LIVE);
    await lockIssueForWrite(db, ISSUE, { actor: system }, 'cascade');
    expect(statements[0]?.text).not.toContain('sync_groups" &&');
    expect(statements[0]?.params).toEqual([ISSUE]);
  });
});
