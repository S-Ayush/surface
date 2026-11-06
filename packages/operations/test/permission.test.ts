// SPEC-003 §5: an operation's predicate runs against the actor; a failure explains who may act.
import { systemActor, userActor } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { evaluatePermission, forbiddenReason } from '../src/index.js';
import { teamUpdate } from './fixtures.js';

const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering', syncGroups: ['workspace'] };
const input = { team: 'ENG', name: 'Eng' };

const actor = (role: 'admin' | 'member', teamIds: string[] = []) =>
  userActor({
    userId: 'u-1',
    role,
    memberships: teamIds.map((teamId) => ({ teamId, private: false })),
  });

describe('evaluatePermission', () => {
  it('allows an Admin and a team member', () => {
    expect(evaluatePermission(teamUpdate, actor('admin'), { team: ENG }, input)).toEqual({
      allowed: true,
    });
    expect(evaluatePermission(teamUpdate, actor('member', [ENG.id]), { team: ENG }, input)).toEqual(
      {
        allowed: true,
      },
    );
  });

  it('explains who may run the operation when the actor may not', () => {
    expect(evaluatePermission(teamUpdate, actor('member'), { team: ENG }, input)).toEqual({
      allowed: false,
      reason:
        "Only Admins or members of Engineering can update a team's name, icon, color or timezone.",
    });
  });

  it('lets the system actor through', () => {
    expect(evaluatePermission(teamUpdate, systemActor(), {}, input)).toEqual({ allowed: true });
  });
});

describe('forbiddenReason', () => {
  it('joins three audiences with commas and "or"', () => {
    expect(forbiddenReason(['Admins', 'its creator', 'members of Ops'], 'Delete a comment.')).toBe(
      'Only Admins, its creator or members of Ops can delete a comment.',
    );
  });

  it('falls back to a plain message when no predicate named an audience', () => {
    expect(forbiddenReason([], 'Change a user’s role')).toBe(
      "You don't have permission to change a user’s role.",
    );
  });
});
