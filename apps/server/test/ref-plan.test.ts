// SPEC-003 §4: the resolver finds every reference in an input and orders scopes first.
import {
  IssueRef,
  LabelRef,
  scopedTo,
  StatusRef,
  TeamRef,
  UserRef,
  UserRefIncludingInactive,
} from '@surface/domain';
import { defineOperation } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refPlan, RefPlanError, scopeTeamOf } from '../src/executor/refs/resolve.js';

function op(input: z.ZodObject) {
  return defineOperation({
    name: 'debug.refs',
    kind: 'query',
    domain: 'debug',
    summary: 'Resolve references',
    description: 'Test fixture for the reference planner.',
    keywords: ['refs', 'resolve'],
    input,
    output: z.object({}),
    permission: () => true,
    destructive: false,
    examples: [],
    internal: true,
  });
}

describe('refPlan', () => {
  it('orders a scoped reference after its team, wherever the fields appear', () => {
    const plan = refPlan(op(z.object({ status: StatusRef, title: z.string(), team: TeamRef })));
    expect(plan.map((l) => [l.key, l.type, l.scope])).toEqual([
      ['team', 'TeamRef', undefined],
      ['status', 'StatusRef', 'team'],
    ]);
  });

  it('finds optional, nullable, nested and list references', () => {
    const plan = refPlan(
      op(
        z.object({
          team: TeamRef,
          assignee: UserRef.nullable().optional(),
          owner: z.object({ user: UserRefIncludingInactive }).optional(),
          labels: z.array(LabelRef).optional(),
        }),
      ),
    );
    expect(plan).toEqual([
      { path: ['team'], key: 'team', type: 'TeamRef', many: false, allowInactive: false },
      { path: ['assignee'], key: 'assignee', type: 'UserRef', many: false, allowInactive: false },
      {
        path: ['owner', 'user'],
        key: 'owner.user',
        type: 'UserRef',
        many: false,
        allowInactive: true,
      },
      {
        path: ['labels'],
        key: 'labels',
        type: 'LabelRef',
        many: true,
        allowInactive: false,
        scope: 'team',
        scopeType: 'TeamRef',
      },
    ]);
  });

  it('follows scopedTo to another TeamRef field', () => {
    const plan = refPlan(op(z.object({ toTeam: TeamRef, status: scopedTo(StatusRef, 'toTeam') })));
    expect(plan.find((l) => l.key === 'status')?.scope).toBe('toTeam');
  });

  it('resolves labels without a team field against workspace labels only', () => {
    const plan = refPlan(op(z.object({ label: LabelRef })));
    expect(plan).toEqual([
      { path: ['label'], key: 'label', type: 'LabelRef', many: false, allowInactive: false },
    ]);
  });

  it('rejects a status without a team field, naming the fix', () => {
    expect(() => refPlan(op(z.object({ status: StatusRef })))).toThrow(
      new RefPlanError(
        'debug.refs: status is a StatusRef, which needs a TeamRef field "team" in the input. Add it, or point the scope elsewhere with scopedTo().',
      ),
    );
  });

  it('rejects a scope field that is not a single TeamRef', () => {
    expect(() => refPlan(op(z.object({ team: z.array(TeamRef), status: StatusRef })))).toThrow(
      /must be a single TeamRef or IssueRef/,
    );
  });

  it('refuses references it cannot resolve, so none reaches a handler unchecked', () => {
    expect(() =>
      refPlan(op(z.object({ items: z.array(z.object({ assignee: UserRef })) }))),
    ).toThrow(/is in a position the resolver does not support/);
    expect(() => refPlan(op(z.object({ who: z.union([UserRef, z.number()]) })))).toThrow(
      RefPlanError,
    );
  });

  it("scopes a status and labels to an issue: the issue's team, not a team named elsewhere (PLAN-011 S4)", () => {
    const plan = refPlan(
      op(
        z.object({
          team: TeamRef.optional(),
          issue: IssueRef,
          status: scopedTo(StatusRef, 'issue'),
          addLabels: z.array(scopedTo(LabelRef, 'issue')),
        }),
      ),
    );
    const status = plan.find((l) => l.key === 'status');
    expect([status?.scope, status?.scopeType]).toEqual(['issue', 'IssueRef']);
    const at = (key: string) => plan.findIndex((l) => l.key === key);
    expect(at('issue')).toBeLessThan(at('status'));
    const resolved = {
      team: { id: 'team-a', key: 'ENG' },
      issue: { id: 'issue-1', teamId: 'team-b', teamKey: 'DES', number: 4 },
    };
    for (const key of ['status', 'addLabels']) {
      const location = plan.find((l) => l.key === key);
      if (!location) throw new Error(key);
      expect(scopeTeamOf(location, resolved)).toEqual({ id: 'team-b', key: 'DES' });
    }
  });

  it('caches the plan per operation', () => {
    const def = op(z.object({ team: TeamRef }));
    expect(refPlan(def)).toBe(refPlan(def));
  });
});
