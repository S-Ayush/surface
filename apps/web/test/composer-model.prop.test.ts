// PLAN-012 S5, AC-2: for any composer state and any target team, a team change keeps only what
// fits the target (its statuses, its and workspace labels, an allowed estimate, an assignee who
// can see it), keeps title, description, priority and due date, names each dropped value once,
// and changing again to the same team drops nothing.
import { isValidEstimate } from '@surface/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  changeTeam,
  type ComposerState,
  type ComposerTeam,
  type ComposerWorld,
} from '../src/features/issues/composer-model.js';

const SCALES = ['off', 'linear', 'exponential', 'fibonacci', 'tshirt'] as const;
const USERS = ['u1', 'u2', 'u3', 'u4'];

const teamArb = (id: string): fc.Arbitrary<ComposerTeam> =>
  fc.record({
    id: fc.constant(id),
    key: fc.constant(id.toUpperCase()),
    name: fc.constant(id),
    private: fc.boolean(),
    defaultStatusId: fc.constant(`${id}-s0`),
    estimate: fc.record({
      scale: fc.constantFrom(...SCALES),
      extended: fc.boolean(),
      allowZero: fc.boolean(),
    }),
  });

const worldArb: fc.Arbitrary<ComposerWorld> = fc
  .record({
    a: teamArb('a'),
    b: teamArb('b'),
    membersA: fc.subarray(USERS),
    membersB: fc.subarray(USERS),
    archived: fc.subarray(['la1', 'lb1', 'lw1']),
    inactive: fc.subarray(USERS),
  })
  .map(({ a, b, membersA, membersB, archived, inactive }) => ({
    me: 'u1',
    teams: [a, b],
    memberTeamIds: ['a', 'b'],
    members: { a: membersA, b: membersB },
    statuses: ['a', 'b'].flatMap((t) =>
      (['triage', 'backlog', 'unstarted', 'started'] as const).map((category, i) => ({
        id: `${t}-s${String(i)}`,
        teamId: t,
        name: `${t} ${category}`,
        category,
        position: 'a0',
        color: 'gray' as const,
      })),
    ),
    labels: [
      { id: 'la1', teamId: 'a' },
      { id: 'lb1', teamId: 'b' },
      { id: 'lw1', teamId: null },
      { id: 'lw2', teamId: null },
    ].map((l) => ({
      ...l,
      name: l.id,
      archived: archived.includes(l.id),
      isGroup: false,
      parentId: null,
      exclusive: false,
      color: 'blue' as const,
    })),
    users: USERS.map((id) => ({
      id,
      name: id,
      displayName: id,
      email: `${id}@example.com`,
      active: !inactive.includes(id),
    })),
    homeTeamId: null,
  }));

const stateArb: fc.Arbitrary<ComposerState> = fc.record({
  teamId: fc.constantFrom('a', 'b'),
  title: fc.string(),
  description: fc.constant(null),
  statusId: fc.option(fc.constantFrom('a-s0', 'a-s1', 'a-s2', 'b-s1', 'b-s3', 'gone'), {
    nil: null,
  }),
  priority: fc.integer({ min: 0, max: 4 }),
  assigneeId: fc.option(fc.constantFrom(...USERS, 'nobody'), { nil: null }),
  labelIds: fc.uniqueArray(fc.constantFrom('la1', 'lb1', 'lw1', 'lw2', 'gone'), { maxLength: 4 }),
  estimate: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
  dueDate: fc.option(fc.constant('2026-12-01'), { nil: null }),
});

describe('changeTeam (property)', () => {
  it('keeps only what fits the target, keeps the free fields, and names each drop once', () => {
    fc.assert(
      fc.property(worldArb, stateArb, fc.constantFrom('a', 'b'), (world, state, target) => {
        const team = world.teams.find((t) => t.id === target);
        if (team === undefined) return;
        const { state: next, dropped } = changeTeam(world, state, target);

        expect(next.teamId).toBe(target);
        expect(next.title).toBe(state.title);
        expect(next.description).toBe(state.description);
        expect(next.priority).toBe(state.priority);
        expect(next.dueDate).toBe(state.dueDate);

        const status = world.statuses.find((s) => s.id === next.statusId);
        if (next.statusId !== null) {
          expect(status?.teamId).toBe(target);
          expect(status?.category).not.toBe('triage');
        }
        for (const id of next.labelIds) {
          const label = world.labels.find((l) => l.id === id);
          expect(label?.archived).toBe(false);
          expect(label?.teamId === null || label?.teamId === target).toBe(true);
        }
        expect(next.labelIds.every((id) => state.labelIds.includes(id))).toBe(true);
        if (next.estimate !== null)
          expect(isValidEstimate(team.estimate, next.estimate)).toBe(true);
        if (next.assigneeId !== null) {
          const user = world.users.find((u) => u.id === next.assigneeId);
          expect(user?.active).toBe(true);
          if (team.private) expect(world.members[target]).toContain(next.assigneeId);
        }

        const removed =
          Number(state.statusId !== next.statusId) +
          (state.labelIds.length - next.labelIds.length) +
          Number(state.estimate !== next.estimate) +
          Number(state.assigneeId !== next.assigneeId);
        expect(dropped).toHaveLength(removed);

        // Fitting is idempotent: the result already fits, so a second change drops nothing.
        expect(changeTeam(world, next, target).dropped).toEqual([]);
      }),
    );
  });
});
