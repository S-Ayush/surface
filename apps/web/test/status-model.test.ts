// PLAN-010 S2 web half: the workflow page's pure model (SPEC-010 §3.1): grouping, the system
// status, who may edit, the form's checks (the server's words), and where Alt+↑/↓ and a drop put
// a status.
import { userActor } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  descriptionText,
  dropTarget,
  moveOne,
  statusFormProblems,
  workflowAccess,
  workflowGroups,
  type StatusItem,
} from '../src/features/statuses/model.js';

const s = (
  id: string,
  category: StatusItem['category'],
  position: string,
  name = id,
): StatusItem => ({
  id,
  teamId: 't',
  name,
  category,
  color: 'gray',
  description: null,
  position,
});

const WORKFLOW = [
  s('triage', 'triage', 'a0'),
  s('backlog', 'backlog', 'a0'),
  s('a', 'started', 'a0'),
  s('b', 'started', 'a1'),
  s('c', 'started', 'a2'),
  s('done', 'completed', 'a0'),
  s('dup', 'duplicate', 'a0'),
];

describe('workflowGroups', () => {
  it('lists the categories in order, with an empty one kept and Triage hidden', () => {
    const groups = workflowGroups(WORKFLOW);
    expect(groups.map((g) => g.title)).toEqual([
      'Backlog',
      'Unstarted',
      'Started',
      'Completed',
      'Canceled',
      'Duplicate',
    ]);
    expect(groups.find((g) => g.category === 'unstarted')?.statuses).toEqual([]);
  });

  it('shows Triage first when triage is on', () => {
    expect(workflowGroups(WORKFLOW, { showTriage: true })[0]?.title).toBe('Triage');
  });

  it('sorts a category by position in byte order and offers "+" except in Duplicate and Triage', () => {
    const groups = workflowGroups(
      [s('x', 'started', 'a0V'), s('y', 'started', 'Zz'), ...WORKFLOW],
      {
        showTriage: true,
      },
    );
    expect(groups.find((g) => g.category === 'started')?.statuses.map((st) => st.id)).toEqual([
      'y',
      'a',
      'x',
      'b',
      'c',
    ]);
    expect(groups.filter((g) => g.canAdd).map((g) => g.category)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
  });
});

describe('moveOne (Alt+↑ / Alt+↓)', () => {
  it('moves one position within the category', () => {
    expect(moveOne(WORKFLOW, 'b', 'up')).toEqual({ before: 'a' });
    expect(moveOne(WORKFLOW, 'b', 'down')).toEqual({ after: 'c' });
  });

  it('does nothing at either end, and never leaves the category', () => {
    expect(moveOne(WORKFLOW, 'a', 'up')).toBeUndefined();
    expect(moveOne(WORKFLOW, 'c', 'down')).toBeUndefined();
    expect(moveOne(WORKFLOW, 'done', 'up')).toBeUndefined();
  });

  it('does nothing for Duplicate and Triage, or an unknown status', () => {
    expect(moveOne(WORKFLOW, 'dup', 'up')).toBeUndefined();
    expect(moveOne(WORKFLOW, 'triage', 'down')).toBeUndefined();
    expect(moveOne(WORKFLOW, 'nope', 'down')).toBeUndefined();
  });
});

describe('dropTarget (drag)', () => {
  it('drops after the row it came from above, before the row it came from below', () => {
    expect(dropTarget(WORKFLOW, 'a', 'c')).toEqual({ after: 'c' });
    expect(dropTarget(WORKFLOW, 'c', 'a')).toEqual({ before: 'a' });
  });

  it('ignores a drop on itself, on another category, on Duplicate, or one that changes nothing', () => {
    expect(dropTarget(WORKFLOW, 'a', 'a')).toBeUndefined();
    expect(dropTarget(WORKFLOW, 'a', 'done')).toBeUndefined();
    expect(dropTarget(WORKFLOW, 'dup', 'done')).toBeUndefined();
    expect(dropTarget(WORKFLOW, 'a', 'b')).toEqual({ after: 'b' });
    expect(dropTarget(WORKFLOW, 'nope', 'b')).toBeUndefined();
  });
});

describe('statusFormProblems', () => {
  const values = { name: 'QA', color: 'gray' as const, description: '' };
  const count = WORKFLOW.length;

  it('accepts a good name', () => {
    expect(statusFormProblems(values, WORKFLOW, { adding: true, count })).toEqual({});
  });

  it('asks for a name, and says how to fix a long one', () => {
    expect(statusFormProblems({ ...values, name: '  ' }, [], { adding: true, count }).name).toBe(
      'Status name is required, like In Review',
    );
    expect(
      statusFormProblems({ ...values, name: 'x'.repeat(51) }, [], { adding: true, count }).name,
    ).toContain('50');
  });

  it('refuses another status’s name in any case, but not the edited status’s own', () => {
    expect(
      statusFormProblems({ ...values, name: 'DONE' }, WORKFLOW, { adding: true, count }).name,
    ).toBe('A status named "DONE" already exists. Choose another name.');
    const others = WORKFLOW.filter((st) => st.id !== 'done');
    expect(
      statusFormProblems({ ...values, name: 'DONE' }, others, { adding: false, count }),
    ).toEqual({});
  });

  it('refuses the 51st status when adding only', () => {
    expect(statusFormProblems(values, [], { adding: true, count: 50 }).name).toBe(
      'A team can have at most 50 statuses. Delete one first.',
    );
    expect(statusFormProblems(values, [], { adding: false, count: 50 })).toEqual({});
  });

  it('limits the description to 255 characters', () => {
    expect(
      statusFormProblems({ ...values, description: 'x'.repeat(256) }, [], { adding: true, count })
        .description,
    ).toContain('255');
  });
});

describe('workflowAccess', () => {
  const team = { id: 't-eng' };
  it('lets members of the team and Admins edit, and nobody else', () => {
    const member = userActor({
      userId: 'u',
      role: 'member',
      memberships: [{ teamId: 't-eng', private: false }],
    });
    const outsider = userActor({ userId: 'u', role: 'member', memberships: [] });
    const admin = userActor({ userId: 'u', role: 'admin', memberships: [] });
    expect(workflowAccess(member, team).edit).toBe(true);
    expect(workflowAccess(outsider, team).edit).toBe(false);
    expect(workflowAccess(admin, team).edit).toBe(true);
    expect(workflowAccess(null, team).edit).toBe(false);
  });
});

describe('descriptionText', () => {
  it('is the trimmed description, or nothing', () => {
    expect(descriptionText({ description: '  Waiting  ' })).toBe('Waiting');
    expect(descriptionText({ description: ' ' })).toBeUndefined();
    expect(descriptionText({ description: null })).toBeUndefined();
  });
});
