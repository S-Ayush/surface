/**
 * Model-based property test for the membership predictions (PLAN-001 S8 handoff, SPEC-003 §8):
 * the real overlay runs the real `team.join`, `team.addMember`, `team.leave` and
 * `team.removeMember` from any replica, and the memberships it shows equal what the server would
 * hold after the same mutations: its handlers' rules (`handlers/teams/shared.ts`), with private
 * teams visible to their members only (permissions.md §5) and a private team keeping its last
 * member (SPEC-001 E12, D3). The signed-in user is an Admin, so permissions never refuse; a
 * refusal of the server alone (visibility, E12) must predict nothing.
 *
 * Leak half: a private team the user isn't in is not in the replica at all (SEC below), and no
 * prediction ever shows a membership of a team the user can't see, or of SEC.
 */
import { NEW_TEAM_SETTINGS, WORKSPACE_GROUP } from '@surface/domain';
import { PRODUCTION_MODELS, TeamMembership } from '@surface/domain/model';
import { teamAddMember, teamJoin, teamLeave, teamRemoveMember } from '@surface/operations';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { decodeRow } from '../src/bootstrap.js';
import { OverlayEngine, type OverlayMutation } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
import { PROPERTY_RUNS, PROPERTY_SEED } from './support/fc.js';
import { id } from './support/models.js';

const AT = '2026-11-12T10:00:00.000Z';
// Unrelated ids, like real UUIDv7s: the overlay's derived membership ids XOR team and user, so
// small sequential ids would collide where real ones don't.
const ME = '0192f0c1-7e5a-7b3c-9d4e-3c1a9f00b001';
const USERS = {
  me: ME,
  iris: '0193a7d2-1b44-7c90-a2f1-6e0d5b7c4e12',
  bob: '01946e83-c9d0-7a15-b8e3-91f2a4d6c723',
} as const;
type UserName = keyof typeof USERS;
const USER_NAMES = Object.keys(USERS) as UserName[];

/** ENG is public, OPS private; SEC is private and never in my replica (I'm not in it). */
const TEAMS = {
  ENG: { id: '0195b1e4-58a7-7d26-8c4f-0a3e7b9d1f34', private: false },
  OPS: { id: '01960c75-e23b-7e37-9d50-b14f8c2e6a45', private: true },
  SEC: { id: '0197d2a6-7fc8-7f48-ae61-c25a9d3f7b56', private: true },
} as const;
type TeamKey = keyof typeof TEAMS;
const TEAM_KEYS = Object.keys(TEAMS) as TeamKey[];

type Op =
  | { readonly kind: 'join' | 'leave'; readonly team: TeamKey }
  | { readonly kind: 'add' | 'remove'; readonly team: TeamKey; readonly user: UserName };

const team = fc.constantFrom(...TEAM_KEYS);
const user = fc.constantFrom(...USER_NAMES);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom('join' as const, 'leave' as const), team }),
  fc.record({ kind: fc.constantFrom('add' as const, 'remove' as const), team, user }),
);
/** The server's memberships before the pending mutations: any subset of team × user. */
const base = fc.subarray(
  TEAM_KEYS.flatMap((t) => USER_NAMES.map((u) => `${t}/${u}`)),
  { minLength: 0 },
);

/** The server: one membership operation, as the handlers apply it. */
function serverApply(state: Set<string>, mutation: Op): void {
  const members = (t: TeamKey) => USER_NAMES.filter((u) => state.has(`${t}/${u}`));
  const visible = (t: TeamKey) => !TEAMS[t].private || state.has(`${t}/me`);
  if (!visible(mutation.team)) return; // NOT_FOUND
  const who: UserName = 'user' in mutation ? mutation.user : 'me';
  const key = `${mutation.team}/${who}`;
  if (mutation.kind === 'join' || mutation.kind === 'add') {
    state.add(key);
    return;
  }
  if (!state.has(key)) return;
  if (TEAMS[mutation.team].private && members(mutation.team).length <= 1) return; // CONFLICT
  state.delete(key);
}

function replica(memberships: readonly string[]): { pool: ObjectPool; engine: OverlayEngine } {
  const pool = new ObjectPool(PRODUCTION_MODELS);
  const audit = { createdAt: AT, updatedAt: AT };
  const row = (model: string, data: object) => ({
    row: decodeRow(pool, model, data),
    archived: false,
  });
  pool.loadBase(
    'User',
    USER_NAMES.map((name) =>
      row('User', {
        ...audit,
        id: USERS[name],
        email: `${name}@example.com`,
        name,
        displayName: name,
        avatarFileId: null,
        timezone: 'UTC',
        role: name === 'me' ? 'admin' : 'member',
        active: true,
      }),
    ),
  );
  // What my connection receives: public teams, and private teams I'm in, with their members.
  const mine = (t: TeamKey) => !TEAMS[t].private || memberships.includes(`${t}/me`);
  const groupsOf = (t: TeamKey) => (TEAMS[t].private ? [`team:${TEAMS[t].id}`] : [WORKSPACE_GROUP]);
  pool.loadBase(
    'Team',
    TEAM_KEYS.filter(mine).map((t) =>
      row('Team', {
        ...NEW_TEAM_SETTINGS,
        ...audit,
        id: TEAMS[t].id,
        key: t,
        name: t,
        icon: null,
        private: TEAMS[t].private,
        defaultStatusId: id(90),
        groups: groupsOf(t),
      }),
    ),
  );
  pool.loadBase(
    'TeamMembership',
    memberships
      .map((m) => m.split('/') as [TeamKey, UserName])
      .filter(([t]) => mine(t))
      .map(([t, u], index) =>
        row('TeamMembership', {
          ...audit,
          id: id(100 + index),
          teamId: TEAMS[t].id,
          userId: USERS[u],
          triageResponsible: false,
          groups: groupsOf(t),
        }),
      ),
  );
  return { pool, engine: new OverlayEngine(pool, () => ME) };
}

function overlayMutation(mutation: Op, seq: number): OverlayMutation {
  const now = new Date(AT);
  const key = `c:${seq}`;
  switch (mutation.kind) {
    case 'join':
      return { key, now, op: teamJoin, input: { team: mutation.team } };
    case 'leave':
      return { key, now, op: teamLeave, input: { team: mutation.team } };
    case 'add':
      return {
        key,
        now,
        op: teamAddMember,
        input: { team: mutation.team, user: USERS[mutation.user] },
      };
    case 'remove':
      return {
        key,
        now,
        op: teamRemoveMember,
        input: { team: mutation.team, user: USERS[mutation.user] },
      };
  }
}

/** The memberships the replica shows, as `TEAM/user`. */
function shown(pool: ObjectPool): string[] {
  const teamKey = new Map<string, TeamKey>(TEAM_KEYS.map((t) => [TEAMS[t].id, t]));
  const userName = new Map<string, UserName>(USER_NAMES.map((u) => [USERS[u], u]));
  return pool
    .all(TeamMembership)
    .map((m) => `${teamKey.get(m.teamId) ?? m.teamId}/${userName.get(m.userId) ?? m.userId}`)
    .sort();
}

it('shows the memberships the server will hold after the pending membership mutations', () => {
  fc.assert(
    fc.property(base, fc.array(op, { maxLength: 8 }), (memberships, ops) => {
      const { pool, engine } = replica(memberships);
      engine.rebuild(ops.map(overlayMutation));

      const server = new Set(memberships);
      for (const mutation of ops) serverApply(server, mutation);
      // What my replica holds of the server's state: rows of teams it received.
      const visibleAtStart = (t: TeamKey) => !TEAMS[t].private || memberships.includes(`${t}/me`);
      const expected = [...server].filter((m) => visibleAtStart(m.split('/')[0] as TeamKey));
      expect(shown(pool)).toEqual(expected.sort());
      // Leak half: nothing of SEC unless I was in it, and never a team the replica lacks.
      if (!memberships.includes('SEC/me')) {
        expect(shown(pool).some((m) => m.startsWith('SEC/'))).toBe(false);
      }
    }),
    { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
  );
});

it('predicts the same on a rebuild, mutation by mutation', () => {
  fc.assert(
    fc.property(base, fc.array(op, { maxLength: 8 }), (memberships, ops) => {
      const pushed = replica(memberships);
      ops.forEach((mutation, seq) => pushed.engine.push(overlayMutation(mutation, seq)));
      const rebuilt = replica(memberships);
      rebuilt.engine.rebuild(ops.map(overlayMutation));
      expect(shown(pushed.pool)).toEqual(shown(rebuilt.pool));
    }),
    { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
  );
});
