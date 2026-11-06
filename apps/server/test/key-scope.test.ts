// permissions.md §3.5: API-key scope, destructive flag and team narrowing (wired to keys in M6).
import { LabelRef, StatusRef, TeamRef, UserRef, type ApiKeyScope } from '@surface/domain';
import { defineOperation } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  keyScopeProblem,
  narrowToKeyTeams,
  refOutsideKeyTeams,
} from '../src/executor/key-scope.js';
import { refPlan } from '../src/executor/refs/resolve.js';
import { actorFor, systemActor } from './helpers.js';

function op(kind: 'query' | 'mutation', destructive: boolean) {
  return defineOperation({
    name: kind === 'query' ? 'debug.read' : destructive ? 'debug.purge' : 'debug.write',
    kind,
    domain: 'debug',
    summary: 'Test operation',
    description: 'Fixture for key-scope tests.',
    keywords: ['test', 'fixture'],
    input: z.object({
      team: TeamRef,
      status: StatusRef.optional(),
      labels: z.array(LabelRef).optional(),
      user: UserRef.optional(),
    }),
    output: z.object({}),
    permission: () => true,
    destructive,
    examples: [],
    internal: true,
  });
}

const query = op('query', false);
const mutation = op('mutation', false);
const destructive = op('mutation', true);

const key = (overrides: Partial<ApiKeyScope> = {}): ApiKeyScope => ({
  id: 'key-1',
  scope: 'read_write',
  teamIds: [],
  allowDestructive: false,
  ...overrides,
});
const user = {
  id: 'u-1',
  role: 'admin' as const,
  memberships: [
    { teamId: 'eng', private: false },
    { teamId: 'sec', private: true },
    { teamId: 'red', private: true },
  ],
};

describe('keyScopeProblem', () => {
  it('lets session and system actors through', () => {
    expect(keyScopeProblem(destructive, actorFor(user))).toBeUndefined();
    expect(keyScopeProblem(destructive, systemActor())).toBeUndefined();
  });

  it('lets a read key run queries only', () => {
    const actor = actorFor(user, { kind: 'api', apiKey: key({ scope: 'read' }) });
    expect(keyScopeProblem(query, actor)).toBeUndefined();
    expect(keyScopeProblem(mutation, actor)).toBe(
      "This API key is read-only, so it can't run debug.write. Use a read-write key.",
    );
  });

  it('needs allow-destructive for destructive operations', () => {
    const plain = actorFor(user, { kind: 'mcp', apiKey: key() });
    expect(keyScopeProblem(mutation, plain)).toBeUndefined();
    expect(keyScopeProblem(destructive, plain)).toBe(
      'This API key can\'t run destructive operations like debug.purge. Use a key with "allow destructive" turned on.',
    );
    const allowed = actorFor(user, { kind: 'mcp', apiKey: key({ allowDestructive: true }) });
    expect(keyScopeProblem(destructive, allowed)).toBeUndefined();
  });
});

describe('team narrowing', () => {
  const narrowed = narrowToKeyTeams(
    actorFor(user, { kind: 'api', apiKey: key({ teamIds: ['eng', 'sec'] }) }),
  );

  it('drops private-team groups and memberships outside the key’s teams', () => {
    expect(narrowed.groups).toEqual(['workspace', 'user:u-1', 'team:sec']);
    expect(narrowed.memberOf).toEqual(['eng', 'sec']);
  });

  it('leaves an actor without team limits unchanged', () => {
    const actor = actorFor(user, { kind: 'api', apiKey: key() });
    expect(narrowToKeyTeams(actor)).toBe(actor);
  });

  it('finds a resolved reference in a team outside the key, through its team id', () => {
    const plan = refPlan(mutation);
    const eng = { id: 'eng' };
    const ops = { id: 'ops' };
    expect(refOutsideKeyTeams(narrowed, plan, { team: eng, user: { id: 'u-9' } })).toBeUndefined();
    expect(refOutsideKeyTeams(narrowed, plan, { team: ops })?.location.key).toBe('team');
    expect(
      refOutsideKeyTeams(narrowed, plan, {
        team: eng,
        status: { id: 's', teamId: 'eng' },
        labels: [
          { id: 'l1', teamId: null },
          { id: 'l2', teamId: 'ops' },
        ],
      }),
    ).toMatchObject({ location: { key: 'labels' }, index: 1 });
  });
});
