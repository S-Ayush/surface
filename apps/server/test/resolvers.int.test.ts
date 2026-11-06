// AC-2: every reference type resolves all documented formats; ambiguous names return
// candidates; invisible rows are NOT_FOUND, never FORBIDDEN (SPEC-003 §4, permissions.md §5).
import { randomUUID } from 'node:crypto';
import {
  IssueRef,
  LabelRef,
  StatusRef,
  TeamRef,
  UserRef,
  UserRefIncludingInactive,
} from '@surface/domain';
import { defineOperation, type ResolvedRefs } from '@surface/operations';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SurfaceError } from '../src/executor/errors.js';
import { resolveRefs, type ResolveActor } from '../src/executor/refs/resolve.js';
import { createTestDatabase, withTx, type TestDatabase } from './db.js';

// Fixture tables in their own schema, shaped like PLAN-001 S1's. Once the real tables exist,
// this file switches to them (see PLAN-003 S2 "As built").
const FIXTURE_SCHEMA = 'ref_fixture';

const ids = {
  eng: randomUUID(),
  ops: randomUUID(),
  sec: randomUUID(),
  alex: randomUUID(),
  sam: randomUUID(),
  samUpper: randomUUID(),
  samHidden: randomUUID(),
  retired: randomUUID(),
  engTodo: randomUUID(),
  engReview: randomUUID(),
  engReviewLower: randomUUID(),
  opsTodo: randomUUID(),
  secTodo: randomUUID(),
  wsBug: randomUUID(),
  wsFeature: randomUUID(),
  engBug: randomUUID(),
  engType: randomUUID(),
  engArea: randomUUID(),
  engPerfType: randomUUID(),
  engPerfArea: randomUUID(),
  secClassified: randomUUID(),
};
const SEC_GROUP = `team:${ids.sec}`;

const member: ResolveActor = {
  kind: 'user',
  userId: ids.alex,
  groups: ['workspace', `user:${ids.alex}`],
};
const secMember: ResolveActor = { ...member, groups: [...member.groups, SEC_GROUP] };
const system: ResolveActor = { kind: 'system', groups: [] };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`
    CREATE SCHEMA ${FIXTURE_SCHEMA};
    SET search_path TO ${FIXTURE_SCHEMA};
    CREATE TABLE teams (
      id uuid PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL,
      private boolean NOT NULL, sync_groups text[] NOT NULL);
    CREATE TABLE users (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
      display_name text NOT NULL UNIQUE, role text NOT NULL, active boolean NOT NULL,
      sync_groups text[] NOT NULL);
    CREATE TABLE workflow_statuses (
      id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams, name text NOT NULL,
      category text NOT NULL, sync_groups text[] NOT NULL, UNIQUE (team_id, name));
    CREATE TABLE labels (
      id uuid PRIMARY KEY, team_id uuid REFERENCES teams, parent_id uuid REFERENCES labels,
      name text NOT NULL, is_group boolean NOT NULL, sync_groups text[] NOT NULL);
  `);
  const q = (sql: string, params: unknown[]) => db.pool.query(sql, params);
  const team = 'INSERT INTO ref_fixture.teams VALUES ($1, $2, $3, $4, $5)';
  await q(team, [ids.eng, 'ENG', 'Engineering', false, ['workspace']]);
  await q(team, [ids.ops, 'OPS', 'Operations', false, ['workspace']]);
  await q(team, [ids.sec, 'SEC', 'Security', true, [SEC_GROUP]]);

  const user = 'INSERT INTO ref_fixture.users VALUES ($1, $2, $3, $4, $5, $6, $7)';
  await q(user, [ids.alex, 'alex@example.com', 'Alex Kim', 'alex', 'member', true, ['workspace']]);
  await q(user, [ids.sam, 'sam@example.com', 'Sam Lee', 'sam', 'member', true, ['workspace']]);
  await q(user, [
    ids.samUpper,
    'sam2@example.com',
    'Sam Park',
    'Sam',
    'admin',
    true,
    ['workspace'],
  ]);
  // Not realistic for users (always `workspace`), but proves candidates are filtered in SQL.
  await q(user, [
    ids.samHidden,
    'sam3@example.com',
    'Sam Hidden',
    'sAm',
    'member',
    true,
    [SEC_GROUP],
  ]);
  await q(user, [
    ids.retired,
    'old@example.com',
    'Old Timer',
    'old',
    'member',
    false,
    ['workspace'],
  ]);

  const status = 'INSERT INTO ref_fixture.workflow_statuses VALUES ($1, $2, $3, $4, $5)';
  await q(status, [ids.engTodo, ids.eng, 'Todo', 'unstarted', ['workspace']]);
  await q(status, [ids.engReview, ids.eng, 'Review', 'started', ['workspace']]);
  await q(status, [ids.engReviewLower, ids.eng, 'review', 'started', ['workspace']]);
  await q(status, [ids.opsTodo, ids.ops, 'Todo', 'unstarted', ['workspace']]);
  await q(status, [ids.secTodo, ids.sec, 'Todo', 'unstarted', [SEC_GROUP]]);

  const label = 'INSERT INTO ref_fixture.labels VALUES ($1, $2, $3, $4, $5, $6)';
  await q(label, [ids.wsBug, null, null, 'Bug', false, ['workspace']]);
  await q(label, [ids.wsFeature, null, null, 'Feature', false, ['workspace']]);
  await q(label, [ids.engBug, ids.eng, null, 'Bug', false, ['workspace']]);
  await q(label, [ids.engType, ids.eng, null, 'Type', true, ['workspace']]);
  await q(label, [ids.engArea, ids.eng, null, 'Area', true, ['workspace']]);
  await q(label, [ids.engPerfType, ids.eng, ids.engType, 'Perf', false, ['workspace']]);
  await q(label, [ids.engPerfArea, ids.eng, ids.engArea, 'Perf', false, ['workspace']]);
  await q(label, [ids.secClassified, ids.sec, null, 'Classified', false, [SEC_GROUP]]);
});

afterAll(async () => {
  await db.drop();
});

function op(input: z.ZodObject) {
  return defineOperation({
    name: 'debug.refs',
    kind: 'query',
    domain: 'debug',
    summary: 'Resolve references',
    description: 'Test fixture for the reference resolvers.',
    keywords: ['refs', 'resolve'],
    input,
    output: z.object({}),
    permission: () => true,
    destructive: false,
    examples: [],
    internal: true,
  });
}

const teamOp = op(z.object({ team: TeamRef }));
const userOp = op(z.object({ user: UserRef }));
const anyUserOp = op(z.object({ user: UserRefIncludingInactive }));
const statusOp = op(z.object({ team: TeamRef.optional(), status: StatusRef }));
const labelOp = op(z.object({ team: TeamRef.optional(), labels: z.array(LabelRef) }));
const issueOp = op(z.object({ issue: IssueRef }));

/** Resolves inside a rolled-back transaction, the way the executor will. */
async function resolve(
  def: ReturnType<typeof op>,
  input: Record<string, unknown>,
  actor: ResolveActor = member,
): Promise<ResolvedRefs> {
  return withTx(db.pool, async (tx: pg.PoolClient) => {
    await tx.query(`SET LOCAL search_path TO ${FIXTURE_SCHEMA}, public`);
    return resolveRefs(def, def.input.parse(input), actor, tx);
  });
}

async function failure(
  def: ReturnType<typeof op>,
  input: Record<string, unknown>,
  actor: ResolveActor = member,
): Promise<SurfaceError> {
  const error: unknown = await resolve(def, input, actor).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SurfaceError))
    throw new Error(`expected a SurfaceError, got ${String(error)}`);
  return error;
}

/** The resolved id, or ids for a list of references. */
function idOf(refs: ResolvedRefs, key: string): string | string[] | undefined {
  const ref = refs[key];
  if (ref === undefined) return undefined;
  return 'id' in ref ? ref.id : ref.map((r) => r.id);
}

describe('TeamRef', () => {
  it.each(['ENG', 'eng', 'Eng'])('resolves the key %s case-insensitively', async (key) => {
    expect(idOf(await resolve(teamOp, { team: key }), 'team')).toBe(ids.eng);
  });

  it('resolves a team id and returns the row the permission check needs', async () => {
    const refs = await resolve(teamOp, { team: ids.ops });
    expect(refs.team).toEqual({
      id: ids.ops,
      key: 'OPS',
      name: 'Operations',
      private: false,
      syncGroups: ['workspace'],
    });
  });

  it('reports an unknown key as NOT_FOUND with the path and a hint', async () => {
    const error = await failure(teamOp, { team: 'NOPE' });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Team "NOPE" not found. Use a team key like ENG, or a team id.');
    expect(error.details.issues?.[0]?.path).toEqual(['team']);
  });

  it('reports a private team the actor cannot see exactly like a missing one', async () => {
    const hidden = await failure(teamOp, { team: ids.sec });
    const absentId = randomUUID();
    const missing = await failure(teamOp, { team: absentId });
    expect(hidden.code).toBe('NOT_FOUND');
    const blank = (e: SurfaceError, value: string) =>
      JSON.stringify({ code: e.code, message: e.message, details: e.details }).replaceAll(
        value,
        '…',
      );
    // Same code, message and details once the id itself is blanked out: nothing to tell them apart.
    expect(blank(hidden, ids.sec)).toBe(blank(missing, absentId));
    expect((await failure(teamOp, { team: 'sec' })).code).toBe('NOT_FOUND');
  });

  it('resolves a private team for its members and for the system actor', async () => {
    expect(idOf(await resolve(teamOp, { team: 'SEC' }, secMember), 'team')).toBe(ids.sec);
    expect(idOf(await resolve(teamOp, { team: 'SEC' }, system), 'team')).toBe(ids.sec);
  });
});

describe('UserRef', () => {
  it.each([
    ['a user id', () => ids.alex, ids.alex],
    ['an email in any case', () => 'ALEX@example.com', ids.alex],
    ['a display name in any case', () => 'ALEX', ids.alex],
    ['"me"', () => 'me', ids.alex],
  ])('resolves %s', async (_format, value, expected) => {
    expect(idOf(await resolve(userOp, { user: value() }), 'user')).toBe(expected);
  });

  it('returns public user fields only', async () => {
    const refs = await resolve(userOp, { user: 'alex' });
    expect(refs.user).toEqual({
      id: ids.alex,
      email: 'alex@example.com',
      name: 'Alex Kim',
      displayName: 'alex',
      role: 'member',
      active: true,
      syncGroups: ['workspace'],
    });
  });

  it('rejects "me" for the system actor (E1)', async () => {
    const error = await failure(userOp, { user: 'me' }, system);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe("'me' requires a user actor");
  });

  it('prefers the exact-case display name over other case variants', async () => {
    expect(idOf(await resolve(userOp, { user: 'sam' }), 'user')).toBe(ids.sam);
    expect(idOf(await resolve(userOp, { user: 'Sam' }), 'user')).toBe(ids.samUpper);
  });

  it('lists only visible candidates when a name is ambiguous', async () => {
    const error = await failure(userOp, { user: 'SAM' });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('2 users match "SAM". Use the email or the user id instead.');
    expect(error.details.candidates).toEqual([
      { id: ids.samUpper, label: 'Sam (sam2@example.com)' },
      { id: ids.sam, label: 'sam (sam@example.com)' },
    ]);
    const forSec = await failure(userOp, { user: 'SAM' }, secMember);
    expect(forSec.details.candidates).toHaveLength(3);
  });

  it('rejects a deactivated user unless the field allows it', async () => {
    const error = await failure(userOp, { user: 'old@example.com' });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(
      'old is deactivated. Choose an active user, or reactivate them first.',
    );
    expect(idOf(await resolve(anyUserOp, { user: 'old' }), 'user')).toBe(ids.retired);
  });

  it('reports an unknown user as NOT_FOUND', async () => {
    expect((await failure(userOp, { user: 'nobody@example.com' })).code).toBe('NOT_FOUND');
  });
});

describe('StatusRef', () => {
  it('resolves a name within the scope team, after the team', async () => {
    expect(idOf(await resolve(statusOp, { team: 'ENG', status: 'todo' }), 'status')).toBe(
      ids.engTodo,
    );
    expect(idOf(await resolve(statusOp, { team: 'OPS', status: 'Todo' }), 'status')).toBe(
      ids.opsTodo,
    );
  });

  it('resolves a status id only within the scope team', async () => {
    expect(idOf(await resolve(statusOp, { team: 'ENG', status: ids.engTodo }), 'status')).toBe(
      ids.engTodo,
    );
    const error = await failure(statusOp, { team: 'ENG', status: ids.opsTodo });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      `Status "${ids.opsTodo}" not found in ENG. Use a status name of that team, or a status id.`,
    );
  });

  it('returns candidates for an ambiguous name and picks the exact case otherwise', async () => {
    expect(idOf(await resolve(statusOp, { team: 'ENG', status: 'review' }), 'status')).toBe(
      ids.engReviewLower,
    );
    const error = await failure(statusOp, { team: 'ENG', status: 'REVIEW' });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.candidates?.map((c) => c.label)).toEqual(['Review', 'review']);
  });

  it('needs the team to be set', async () => {
    const error = await failure(statusOp, { status: 'Todo' });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Status "Todo" needs a team. Set the team as well.');
    expect(error.details.issues?.[0]?.path).toEqual(['status']);
  });

  it("hides a private team's statuses behind the team's own NOT_FOUND", async () => {
    expect((await failure(statusOp, { team: 'SEC', status: 'Todo' })).message).toMatch(
      /^Team "SEC"/,
    );
    expect(
      idOf(await resolve(statusOp, { team: 'SEC', status: 'Todo' }, secMember), 'status'),
    ).toBe(ids.secTodo);
  });
});

describe('LabelRef', () => {
  it("prefers the team's label over a workspace label with the same name", async () => {
    const refs = await resolve(labelOp, { team: 'ENG', labels: ['bug', 'Feature'] });
    expect(idOf(refs, 'labels')).toEqual([ids.engBug, ids.wsFeature]);
  });

  it('uses workspace labels only when there is no team', async () => {
    expect(idOf(await resolve(labelOp, { labels: ['Bug'] }), 'labels')).toEqual([ids.wsBug]);
    const error = await failure(labelOp, { labels: ['Feature', 'Perf'] });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      'Label "Perf" not found in the workspace labels. Use a label name or a label id.',
    );
    expect(error.details.issues?.[0]?.path).toEqual(['labels', 1]);
  });

  it('names the group of each candidate when a label name is ambiguous', async () => {
    const error = await failure(labelOp, { team: 'ENG', labels: ['perf'] });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.candidates).toEqual([
      { id: ids.engPerfArea, label: 'Area/Perf' },
      { id: ids.engPerfType, label: 'Type/Perf' },
    ]);
  });

  it('resolves a label id from the team or the workspace, not from another team', async () => {
    expect(idOf(await resolve(labelOp, { team: 'OPS', labels: [ids.wsBug] }), 'labels')).toEqual([
      ids.wsBug,
    ]);
    expect((await failure(labelOp, { team: 'OPS', labels: [ids.engBug] })).code).toBe('NOT_FOUND');
  });

  it("hides a private team's label from non-members, even by id", async () => {
    const error = await failure(labelOp, { labels: [ids.secClassified] }, member);
    expect(error.code).toBe('NOT_FOUND');
    expect(
      idOf(await resolve(labelOp, { team: 'SEC', labels: ['classified'] }, secMember), 'labels'),
    ).toEqual([ids.secClassified]);
  });
});

describe('references not available in M0', () => {
  it('fail as a bug, not as a user error', async () => {
    await expect(resolve(issueOp, { issue: 'ENG-1' })).rejects.toThrow(
      'IssueRef is not available until M1',
    );
  });
});
