// SPEC-003 §5 / permissions.md: actors, sync groups and the predicate helper `p`.
import { describe, expect, it } from 'vitest';
import {
  bindPredicates,
  canSeeGroups,
  syncGroupsFor,
  systemActor,
  userActor,
  type Actor,
} from './permissions.js';

const ENG = { id: 'team-eng', name: 'Engineering', syncGroups: ['workspace'] };
const SEC = { id: 'team-sec', name: 'Security', syncGroups: ['team:team-sec'] };
const OPS = { id: 'team-ops', name: 'Operations', syncGroups: ['workspace'] };

const member = userActor({
  userId: 'u-1',
  role: 'member',
  memberships: [
    { teamId: ENG.id, private: false },
    { teamId: SEC.id, private: true },
  ],
});
const admin = userActor({ userId: 'u-2', role: 'admin', memberships: [] });

describe('actors', () => {
  it('gives a user the workspace group, their own group, and their private teams', () => {
    expect(
      syncGroupsFor('u-1', [
        { teamId: 't1', private: false },
        { teamId: 't2', private: true },
      ]),
    ).toEqual(['workspace', 'user:u-1', 'team:t2']);
  });

  it('records every membership, public or private, for teamMember checks', () => {
    expect(member).toEqual({
      kind: 'user',
      userId: 'u-1',
      role: 'member',
      groups: ['workspace', 'user:u-1', 'team:team-sec'],
      memberOf: ['team-eng', 'team-sec'],
    });
  });

  it('builds API and MCP actors that act as their owner, narrowed by the key', () => {
    const apiKey = { id: 'key-1', scope: 'read' as const, teamIds: [], allowDestructive: false };
    const actor = userActor({
      userId: 'u-1',
      role: 'admin',
      memberships: [],
      via: { kind: 'mcp', apiKey },
    });
    expect(actor).toMatchObject({ kind: 'mcp', userId: 'u-1', role: 'admin', apiKey });
  });

  it('keeps the session a signed-in user acts through, but never for an API key', () => {
    const signedIn = userActor({
      userId: 'u-1',
      role: 'member',
      memberships: [],
      sessionId: 's-1',
    });
    expect(signedIn.sessionId).toBe('s-1');
    const apiKey = { id: 'key-1', scope: 'read' as const, teamIds: [], allowDestructive: false };
    const viaKey = userActor({
      userId: 'u-1',
      role: 'member',
      memberships: [],
      via: { kind: 'api', apiKey },
      sessionId: 's-1',
    });
    expect(viaKey).not.toHaveProperty('sessionId');
  });

  it('has a frozen system actor with no user and no groups', () => {
    expect(systemActor()).toEqual({ kind: 'system', groups: [], memberOf: [] });
    expect(Object.isFrozen(systemActor())).toBe(true);
  });

  it('sees a row when any of its groups is the actor’s; the system actor sees everything', () => {
    expect(canSeeGroups(member, ['team:team-sec'])).toBe(true);
    expect(canSeeGroups(admin, ['team:team-sec'])).toBe(false);
    expect(canSeeGroups(admin, [])).toBe(false);
    expect(canSeeGroups(systemActor(), ['team:anything'])).toBe(true);
  });
});

describe('predicates', () => {
  const pFor = (actor: Actor) => bindPredicates(actor);

  it('any() passes for users and fails without a user', () => {
    expect(pFor(member).p.any()).toBe(true);
    const anonymous: Actor = { kind: 'user', groups: [], memberOf: [] };
    const bound = pFor(anonymous);
    expect(bound.p.any()).toBe(false);
    expect(bound.allowedWho()).toEqual(['signed-in users']);
  });

  it('admin() checks the role', () => {
    expect(pFor(admin).p.admin()).toBe(true);
    const bound = pFor(member);
    expect(bound.p.admin()).toBe(false);
    expect(bound.allowedWho()).toEqual(['Admins']);
  });

  it('self() matches the actor’s own user row', () => {
    expect(pFor(member).p.self({ id: 'u-1' })).toBe(true);
    expect(pFor(member).p.self({ id: 'u-2' })).toBe(false);
  });

  it('teamMember() checks memberships of public and private teams, naming the team', () => {
    expect(pFor(member).p.teamMember(ENG)).toBe(true);
    expect(pFor(member).p.teamMember(SEC)).toBe(true);
    const bound = pFor(member);
    expect(bound.p.teamMember(OPS)).toBe(false);
    expect(bound.allowedWho()).toEqual(['members of Operations']);
  });

  it('canSee() compares the row’s sync groups with the actor’s', () => {
    expect(pFor(member).p.canSee(SEC)).toBe(true);
    expect(pFor(admin).p.canSee(SEC)).toBe(false);
    expect(pFor(admin).p.canSee({ id: 'x' })).toBe(false);
  });

  it('owner() reads creatorId, or the field named', () => {
    expect(pFor(member).p.owner({ id: 'c', creatorId: 'u-1' })).toBe(true);
    expect(pFor(member).p.owner({ id: 'c', creatorId: 'u-2' })).toBe(false);
    const bound = pFor(member);
    expect(bound.p.owner({ id: 'v', ownerId: 'u-2' }, 'ownerId')).toBe(false);
    expect(bound.allowedWho()).toEqual(['its owner']);
  });

  it('fails every predicate for a missing reference', () => {
    const { p } = pFor(admin);
    expect([
      p.self(undefined),
      p.teamMember(undefined),
      p.canSee(undefined),
      p.owner(undefined),
    ]).toEqual([false, false, false, false]);
  });

  it('requires every row of a list to pass, and fails an empty list', () => {
    expect(pFor(member).p.teamMember([ENG, SEC])).toBe(true);
    expect(pFor(member).p.teamMember([ENG, OPS])).toBe(false);
    expect(pFor(member).p.teamMember([])).toBe(false);
  });

  it('passes every predicate for the system actor', () => {
    const { p } = pFor(systemActor());
    expect([
      p.any(),
      p.admin(),
      p.self(undefined),
      p.teamMember(OPS),
      p.canSee(SEC),
      p.owner({ id: 'x' }),
    ]).toEqual([true, true, true, true, true, true]);
  });

  it('records each failed audience once, in call order', () => {
    const bound = pFor(member);
    const allowed = bound.p.admin() || bound.p.teamMember(OPS) || bound.p.admin();
    expect(allowed).toBe(false);
    expect(bound.allowedWho()).toEqual(['Admins', 'members of Operations']);
  });
});
