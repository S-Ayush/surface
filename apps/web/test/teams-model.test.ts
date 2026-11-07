// PLAN-001 S8 web half: the team screens' read models (SPEC-001 §3.7). Browse lists every visible
// team with its member count; members and the people "Add member" offers; who may edit and manage
// members (the operations' own permissions); and E12/D3 (the last member of a private team stays).
import { userActor } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  addableUsers,
  browseTeams,
  canEndMembershipOf,
  teamAccess,
  teamMembers,
  type MembershipRow,
  type TeamRow,
  type UserRow,
} from '../src/features/teams/model.js';

const team = (id: string, key: string, name: string, extra: Partial<TeamRow> = {}): TeamRow => ({
  id,
  key,
  name,
  icon: null,
  color: 'gray',
  timezone: 'UTC',
  private: false,
  ...extra,
});
const user = (id: string, name: string, extra: Partial<UserRow> = {}): UserRow => ({
  id,
  name,
  displayName: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.com`,
  active: true,
  ...extra,
});
const member = (teamId: string, userId: string, extra: Partial<MembershipRow> = {}) => ({
  teamId,
  userId,
  ...extra,
});

const ENG = team('t-eng', 'ENG', 'Engineering');
const DES = team('t-des', 'DES', 'Design', { icon: '🎨', color: 'pink' });
const SEC = team('t-sec', 'SEC', 'Security', { private: true });
const ada = user('u-ada', 'Ada');
const iris = user('u-iris', 'Iris');
const zoe = user('u-zoe', 'Zoe');
const memberships = [member('t-eng', 'u-ada'), member('t-eng', 'u-iris'), member('t-sec', 'u-ada')];

describe('browseTeams', () => {
  it('lists every visible team by name, with member counts and my membership', () => {
    expect(browseTeams([ENG, SEC, DES], memberships, 'u-ada')).toEqual([
      expect.objectContaining({ key: 'DES', icon: '🎨', memberCount: 0, member: false }),
      expect.objectContaining({ key: 'ENG', memberCount: 2, member: true }),
      expect.objectContaining({ key: 'SEC', private: true, memberCount: 1, member: true }),
    ]);
  });

  it('leaves out archived teams and memberships', () => {
    const list = browseTeams(
      [ENG, { ...DES, $archived: true }],
      [...memberships, member('t-eng', 'u-zoe', { $archived: true })],
      'u-zoe',
    );
    expect(list).toEqual([expect.objectContaining({ key: 'ENG', memberCount: 2, member: false })]);
  });
});

describe('teamMembers and addableUsers', () => {
  it('lists the team’s members by name', () => {
    expect(teamMembers('t-eng', memberships, [zoe, iris, ada]).map((u) => u.name)).toEqual([
      'Ada',
      'Iris',
    ]);
  });

  it('offers active people who are not members yet', () => {
    const bob = user('u-bob', 'Bob', { active: false });
    expect(addableUsers('t-eng', memberships, [zoe, iris, ada, bob]).map((u) => u.name)).toEqual([
      'Zoe',
    ]);
  });
});

describe('teamAccess (SPEC-001 §5: team members and Admins)', () => {
  const actor = (role: 'admin' | 'member', teams: string[]) =>
    userActor({
      userId: 'u-x',
      role,
      memberships: teams.map((teamId) => ({ teamId, private: false })),
    });

  it('lets members and Admins edit and manage members', () => {
    expect(teamAccess(actor('member', ['t-eng']), ENG)).toEqual({
      edit: true,
      manageMembers: true,
    });
    expect(teamAccess(actor('admin', []), ENG)).toEqual({ edit: true, manageMembers: true });
  });

  it('shows everyone else the team read-only', () => {
    expect(teamAccess(actor('member', ['t-des']), ENG)).toEqual({
      edit: false,
      manageMembers: false,
    });
    expect(teamAccess(null, ENG)).toEqual({ edit: false, manageMembers: false });
  });
});

describe('canEndMembershipOf (E12, D3)', () => {
  it('keeps the last member of a private team, but not of a public one', () => {
    expect(canEndMembershipOf(SEC, memberships)).toBe(false);
    expect(canEndMembershipOf(SEC, [...memberships, member('t-sec', 'u-iris')])).toBe(true);
    expect(canEndMembershipOf(DES, [member('t-des', 'u-ada')])).toBe(true);
  });
});
