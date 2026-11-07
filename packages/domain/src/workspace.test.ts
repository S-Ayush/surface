import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';
import {
  DEFAULT_STATUS_NAME,
  DEFAULT_TEAM_WORKFLOW,
  DEFAULT_WORKSPACE_LABELS,
  RESERVED_TEAM_KEYS,
  teamKeyProblem,
  workflowProblems,
} from './workspace.js';

const withIds = (categories: readonly StatusCategory[]) =>
  categories.map((category, i) => ({ id: `s${i}`, category }));

const defaults = withIds(DEFAULT_TEAM_WORKFLOW.map((s) => s.category));
const defaultId = `s${DEFAULT_TEAM_WORKFLOW.findIndex((s) => s.name === DEFAULT_STATUS_NAME)}`;

describe('the default team workflow', () => {
  it('satisfies INV-04 and INV-05 with Backlog as the default', () => {
    expect(workflowProblems(defaults, defaultId)).toEqual([]);
  });

  it('has the eight statuses SPEC-001 §4 lists, with unique names', () => {
    expect(DEFAULT_TEAM_WORKFLOW.map((s) => `${s.name}:${s.category}`)).toEqual([
      'Triage:triage',
      'Backlog:backlog',
      'Todo:unstarted',
      'In Progress:started',
      'In Review:started',
      'Done:completed',
      'Canceled:canceled',
      'Duplicate:duplicate',
    ]);
  });

  it('comes with the three workspace labels', () => {
    expect(DEFAULT_WORKSPACE_LABELS.map((l) => `${l.name}:${l.color}`)).toEqual([
      'Bug:red',
      'Feature:violet',
      'Improvement:blue',
    ]);
  });
});

describe('workflowProblems (INV-04, INV-05)', () => {
  it('reports a workflow missing any one required category', () => {
    for (const category of ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const) {
      const statuses = defaults.filter((s) => s.category !== category);
      const problems = workflowProblems(statuses, statuses[0]?.id ?? '');
      expect(problems).toContain(`A team needs at least one ${category} status`);
    }
  });

  it('reports a second Triage or Duplicate status, and a missing one', () => {
    const twoTriage = [...defaults, { id: 'extra', category: 'triage' as const }];
    expect(workflowProblems(twoTriage, defaultId)).toEqual([
      'A team needs exactly one triage status (has 2)',
    ]);
    const noDuplicate = defaults.filter((s) => s.category !== 'duplicate');
    expect(workflowProblems(noDuplicate, defaultId)).toEqual([
      'A team needs exactly one duplicate status (has 0)',
    ]);
  });

  it('accepts a default in Backlog or Unstarted only', () => {
    for (const status of defaults) {
      const ok = status.category === 'backlog' || status.category === 'unstarted';
      expect(workflowProblems(defaults, status.id).length === 0).toBe(ok);
    }
  });

  it("reports a default that isn't one of the team's statuses", () => {
    expect(workflowProblems(defaults, 'elsewhere')).toEqual([
      "The default status must be one of the team's statuses",
    ]);
  });

  it('accepts exactly the workflows that meet INV-04 and INV-05', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...STATUS_CATEGORIES), { maxLength: 14 }),
        fc.nat(),
        (categories, pick) => {
          const statuses = withIds(categories);
          const defaultStatus = statuses[pick % Math.max(statuses.length, 1)];
          const count = (c: StatusCategory) => categories.filter((x) => x === c).length;
          const valid =
            (['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const).every(
              (c) => count(c) >= 1,
            ) &&
            count('triage') === 1 &&
            count('duplicate') === 1 &&
            (defaultStatus?.category === 'backlog' || defaultStatus?.category === 'unstarted');
          const problems = workflowProblems(statuses, defaultStatus?.id ?? 'none');
          expect(problems.length === 0).toBe(valid);
        },
      ),
    );
  });
});

describe('teamKeyProblem (INV-03)', () => {
  it('accepts 2–5 capital letters', () => {
    for (const key of ['EN', 'ENG', 'MOBIL']) expect(teamKeyProblem(key)).toBeUndefined();
  });

  it('rejects other shapes with a message that shows the format', () => {
    for (const key of ['E', 'ENGINE', 'eng', 'EN1', 'EN G', '']) {
      expect(teamKeyProblem(key)).toBe('Team key must be 2–5 capital letters, like ENG');
    }
  });

  it('rejects reserved keys', () => {
    for (const key of RESERVED_TEAM_KEYS) expect(teamKeyProblem(key)).toMatch(/is reserved/);
  });
});
