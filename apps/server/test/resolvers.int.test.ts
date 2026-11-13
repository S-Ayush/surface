// AC-2: every reference type resolves all documented formats; ambiguous names return
// candidates; invisible rows are NOT_FOUND, never FORBIDDEN (SPEC-003 §4, permissions.md §5).
import { randomUUID } from 'node:crypto';
import {
  IssueRef,
  LabelRef,
  ProjectRef,
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
  engSecret: randomUUID(),
  engHush: randomUUID(),
  eng1: randomUUID(),
  ops1: randomUUID(),
  sec1: randomUUID(),
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
    CREATE TABLE issues (
      id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams, number integer NOT NULL,
      sync_groups text[] NOT NULL, UNIQUE (team_id, number));
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
  // Rows inside a visible team whose own groups hide them: only the row's groups filter these.
  await q(status, [ids.engSecret, ids.eng, 'Secret', 'started', [SEC_GROUP]]);

  const label = 'INSERT INTO ref_fixture.labels VALUES ($1, $2, $3, $4, $5, $6)';
  await q(label, [ids.wsBug, null, null, 'Bug', false, ['workspace']]);
  await q(label, [ids.wsFeature, null, null, 'Feature', false, ['workspace']]);
  await q(label, [ids.engBug, ids.eng, null, 'Bug', false, ['workspace']]);
  await q(label, [ids.engType, ids.eng, null, 'Type', true, ['workspace']]);
  await q(label, [ids.engArea, ids.eng, null, 'Area', true, ['workspace']]);
  await q(label, [ids.engPerfType, ids.eng, ids.engType, 'Perf', false, ['workspace']]);
  await q(label, [ids.engPerfArea, ids.eng, ids.engArea, 'Perf', false, ['workspace']]);
  await q(label, [ids.secClassified, ids.sec, null, 'Classified', false, [SEC_GROUP]]);
  await q(label, [ids.engHush, ids.eng, null, 'Hush', false, [SEC_GROUP]]);

  const issue = 'INSERT INTO ref_fixture.issues VALUES ($1, $2, $3, $4)';
  await q(issue, [ids.eng1, ids.eng, 1, ['workspace']]);
  await q(issue, [ids.ops1, ids.ops, 1, ['workspace']]);
  await q(issue, [ids.sec1, ids.sec, 1, [SEC_GROUP]]);
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

  it('filters statuses by their own sync groups, by name and by id', async () => {
    for (const status of ['Secret', ids.engSecret]) {
      const error = await failure(statusOp, { team: 'ENG', status }, member);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe(
        `Status "${status}" not found in ENG. Use a status name of that team, or a status id.`,
      );
      expect(idOf(await resolve(statusOp, { team: 'ENG', status }, secMember), 'status')).toBe(
        ids.engSecret,
      );
    }
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

  it('resolves a label id to any label the actor can see, with or without a team (SPEC-010 §6)', async () => {
    expect(idOf(await resolve(labelOp, { team: 'OPS', labels: [ids.wsBug] }), 'labels')).toEqual([
      ids.wsBug,
    ]);
    expect(idOf(await resolve(labelOp, { team: 'OPS', labels: [ids.engBug] }), 'labels')).toEqual([
      ids.engBug,
    ]);
    expect(idOf(await resolve(labelOp, { labels: [ids.engBug] }), 'labels')).toEqual([ids.engBug]);
  });

  it("does not resolve a team label's name without the team (AC-18)", async () => {
    expect((await failure(labelOp, { labels: ['Area/Perf'] })).code).toBe('NOT_FOUND');
  });

  it('resolves Group/Label with spaces around the slash, and lists the matches of a bare name (AC-18, E9)', async () => {
    const refs = await resolve(labelOp, { team: 'ENG', labels: ['area / perf', 'Type/Perf'] });
    expect(idOf(refs, 'labels')).toEqual([ids.engPerfArea, ids.engPerfType]);
    const error = await failure(labelOp, { team: 'ENG', labels: ['perf'] });
    expect(error.message).toBe(
      "2 labels named 'Perf': Area/Perf, Type/Perf. Use Group/Label or the label id.",
    );
    expect((await failure(labelOp, { team: 'ENG', labels: ['Nope/Perf'] })).code).toBe('NOT_FOUND');
  });

  it("hides a private team's label from non-members, even by id", async () => {
    const error = await failure(labelOp, { labels: [ids.secClassified] }, member);
    expect(error.code).toBe('NOT_FOUND');
    expect(
      idOf(await resolve(labelOp, { team: 'SEC', labels: ['classified'] }, secMember), 'labels'),
    ).toEqual([ids.secClassified]);
  });

  it('filters labels by their own sync groups, by name and by id', async () => {
    for (const label of ['Hush', ids.engHush]) {
      expect((await failure(labelOp, { team: 'ENG', labels: [label] }, member)).code).toBe(
        'NOT_FOUND',
      );
      expect(
        idOf(await resolve(labelOp, { team: 'ENG', labels: [label] }, secMember), 'labels'),
      ).toEqual([ids.engHush]);
    }
  });
});

// PLAN-011 S3, SPEC-011 §5.6 and E13: issues by identifier or id. A missing issue, one in a private
// team the actor isn't in and one outside an API key's teams are the same NOT_FOUND (leak tests,
// permissions.md §5; not held). S4's `issue-leak.int.test.ts` covers the operations.
describe('IssueRef', () => {
  const keyFor = (teamIds: string[]): ResolveActor => ({
    ...member,
    kind: 'api',
    apiKey: { id: randomUUID(), scope: 'read_write', teamIds, allowDestructive: false },
  });
  /**
   * The error with the quoted reference blanked, so two errors compare by wording alone (the
   * hint's own `ENG-123` must stay, so only `"<value>"` is replaced).
   */
  const blank = (e: SurfaceError, value: string) =>
    JSON.stringify({ code: e.code, message: e.message, details: e.details }).replaceAll(
      JSON.stringify(`"${value}"`).slice(1, -1),
      '…',
    );

  it.each(['ENG-1', 'eng-1', ' Eng-1 '])(
    'resolves the identifier %j through the team key',
    async (value) => {
      const refs = await resolve(issueOp, { issue: value });
      expect(refs.issue).toEqual({
        id: ids.eng1,
        teamId: ids.eng,
        teamKey: 'ENG',
        number: 1,
        syncGroups: ['workspace'],
      });
    },
  );

  it('resolves an issue id', async () => {
    expect(idOf(await resolve(issueOp, { issue: ids.ops1.toUpperCase() }), 'issue')).toBe(ids.ops1);
  });

  it('reports a missing issue as NOT_FOUND with the path and a hint', async () => {
    const error = await failure(issueOp, { issue: 'ENG-99' });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      'Issue "ENG-99" not found. Use an issue identifier like ENG-123, or an issue id.',
    );
    expect(error.details.issues?.[0]?.path).toEqual(['issue']);
  });

  // E13: a number past Postgres `integer` (or past 2^53) can't be an issue, so it is NOT_FOUND,
  // not the INTERNAL a query with it would fail with.
  it.each(['ENG-2147483648', 'ENG-99999999999999999999999'])(
    'reports %s, a number no issue can have, like a missing issue',
    async (value) => {
      const error = await failure(issueOp, { issue: value });
      const missing = await failure(issueOp, { issue: 'ENG-99' });
      expect(error.code).toBe('NOT_FOUND');
      expect(blank(error, value)).toBe(blank(missing, 'ENG-99'));
    },
  );

  it("reports a private team's issue to a non-member exactly like a missing one", async () => {
    for (const [hiddenValue, missingValue] of [
      ['SEC-1', 'SEC-2'],
      [ids.sec1, randomUUID()],
    ] as const) {
      const hidden = await failure(issueOp, { issue: hiddenValue });
      const missing = await failure(issueOp, { issue: missingValue });
      expect(blank(hidden, hiddenValue)).toBe(blank(missing, missingValue));
    }
    expect(idOf(await resolve(issueOp, { issue: 'SEC-1' }, secMember), 'issue')).toBe(ids.sec1);
    expect(idOf(await resolve(issueOp, { issue: 'SEC-1' }, system), 'issue')).toBe(ids.sec1);
  });

  it("reports an issue outside an API key's teams exactly like a missing one, public ones too", async () => {
    const opsOnly = keyFor([ids.ops]);
    const hidden = await failure(issueOp, { issue: 'ENG-1' }, opsOnly);
    const missing = await failure(issueOp, { issue: 'ENG-99' }, opsOnly);
    expect(hidden.code).toBe('NOT_FOUND');
    expect(blank(hidden, 'ENG-1')).toBe(blank(missing, 'ENG-99'));
    expect((await failure(issueOp, { issue: ids.eng1 }, opsOnly)).code).toBe('NOT_FOUND');
    expect(idOf(await resolve(issueOp, { issue: 'OPS-1' }, opsOnly), 'issue')).toBe(ids.ops1);
  });

  it('refuses a value that is neither an identifier nor an id at the schema', () => {
    expect(issueOp.input.safeParse({ issue: 'ENG 1' }).success).toBe(false);
  });
});

describe('references not available yet', () => {
  it('fail as a bug, not as a user error', async () => {
    const projectOp = op(z.object({ project: ProjectRef }));
    await expect(resolve(projectOp, { project: 'Launch' })).rejects.toThrow(
      'ProjectRef is not available until M3',
    );
  });
});
