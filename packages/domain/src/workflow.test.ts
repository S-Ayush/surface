// PLAN-010 S1: the pure status rules of SPEC-010 §4.1 and §6. AC-5 (refusal order and messages,
// the auto-close clause included), the pure part of AC-6 (which lifecycle states count), and the
// status half of AC-13 (the 50-status limit) and AC-9-like name rules. The AC-6 property over
// issue sets is `workflow.prop.test.ts` (PLAN-010 S5).
import { describe, expect, it } from 'vitest';
import type { StatusCategory } from './status-category.js';
import {
  STATUS_LIMIT,
  statusDeleteProblem,
  statusLimitProblem,
  statusNameProblem,
  type StatusIssueCounts,
  type WorkflowStatusLike,
} from './workflow.js';
import { DEFAULT_TEAM_WORKFLOW } from './workspace.js';

/** The seeded workflow (SPEC-001 §4), with ids equal to the names. */
const seeded: WorkflowStatusLike[] = DEFAULT_TEAM_WORKFLOW.map((s) => ({
  id: s.name,
  name: s.name,
  category: s.category,
}));
const NONE: StatusIssueCounts = { live: 0, archived: 0, recentlyDeleted: 0 };

function problem(
  statusId: string,
  options: {
    statuses?: WorkflowStatusLike[];
    defaultStatusId?: string;
    counts?: Partial<StatusIssueCounts>;
    autoCloseStatusId?: string | null;
  } = {},
) {
  return statusDeleteProblem(
    { statuses: options.statuses ?? seeded, statusId },
    options.defaultStatusId ?? 'Backlog',
    { ...NONE, ...options.counts },
    options.autoCloseStatusId,
  );
}

function withExtra(name: string, category: StatusCategory): WorkflowStatusLike[] {
  return [...seeded, { id: name, name, category }];
}

describe('statusDeleteProblem (AC-5)', () => {
  it('allows deleting an empty status that is not the last of its category', () => {
    // The seed has two Started statuses: In Progress and In Review.
    expect(problem('In Review')).toBeUndefined();
  });

  it('refuses Triage and Duplicate, which are system statuses', () => {
    expect(problem('Triage')).toEqual({
      reason: 'system',
      message: "Triage is a system status and can't be deleted.",
    });
    expect(problem('Duplicate')).toEqual({
      reason: 'system',
      message: "Duplicate is a system status and can't be deleted.",
    });
  });

  it('refuses the default status', () => {
    const statuses = withExtra('Icebox', 'backlog');
    expect(problem('Backlog', { statuses })).toEqual({
      reason: 'default',
      message: "Can't delete the default status. Make another status the default first.",
    });
  });

  it("refuses the team's auto-close status (SPEC-015 §4.9)", () => {
    const statuses = withExtra('Stale', 'canceled');
    expect(problem('Stale', { statuses, autoCloseStatusId: 'Stale' })).toEqual({
      reason: 'autoClose',
      message:
        'This status closes stale issues. Choose another one in Settings → Automations first.',
    });
    // Without the column (before SPEC-015) or with another status, the rule doesn't apply.
    expect(problem('Stale', { statuses })).toBeUndefined();
    expect(problem('Stale', { statuses, autoCloseStatusId: null })).toBeUndefined();
    expect(problem('Stale', { statuses, autoCloseStatusId: 'Canceled' })).toBeUndefined();
  });

  it('refuses the last status of a category, naming the category', () => {
    expect(problem('Done')).toEqual({
      reason: 'lastInCategory',
      message:
        'Every team needs at least one Completed status. Add another before deleting this one.',
    });
    expect(problem('Todo', { defaultStatusId: 'Backlog' })?.message).toBe(
      'Every team needs at least one Unstarted status. Add another before deleting this one.',
    );
  });

  it('refuses a status with issues, giving the count', () => {
    expect(problem('In Review', { counts: { live: 2 } })).toEqual({
      reason: 'hasIssues',
      message: `Can't delete the "In Review" status. It has 2 issues. Move them to another status first.`,
    });
    expect(problem('In Review', { counts: { live: 1 } })?.message).toBe(
      `Can't delete the "In Review" status. It has 1 issue. Move it to another status first.`,
    );
  });

  it('counts archived and recently deleted issues too, and says how many there are', () => {
    const statuses = withExtra('Won’t do', 'canceled');
    expect(problem('Canceled', { statuses, counts: { live: 1, archived: 1 } })?.message).toBe(
      `Can't delete the "Canceled" status. It has 2 issues (1 archived or recently deleted). Move them to another status first.`,
    );
    expect(problem('Canceled', { statuses, counts: { recentlyDeleted: 1 } })?.message).toBe(
      `Can't delete the "Canceled" status. It has 1 issue (1 archived or recently deleted). Move it to another status first.`,
    );
    expect(
      problem('Canceled', { statuses, counts: { archived: 2, recentlyDeleted: 3 } })?.message,
    ).toBe(
      `Can't delete the "Canceled" status. It has 5 issues (5 archived or recently deleted). Move them to another status first.`,
    );
  });

  it('refuses in the order of SPEC-010 §4.1 when several rules apply', () => {
    // Duplicate with issues: system first.
    expect(problem('Duplicate', { counts: { live: 3 } })?.reason).toBe('system');
    // The default, last of its category, also auto-close (impossible, but ordered) with issues.
    expect(problem('Backlog', { counts: { live: 3 }, autoCloseStatusId: 'Backlog' })?.reason).toBe(
      'default',
    );
    // Auto-close, last of its category, with issues.
    expect(
      problem('Canceled', { counts: { live: 3 }, autoCloseStatusId: 'Canceled' })?.reason,
    ).toBe('autoClose');
    // Last of its category, with issues.
    expect(problem('Done', { counts: { live: 3 } })?.reason).toBe('lastInCategory');
  });

  it('throws for a status outside the workflow: the caller passes the team it locked', () => {
    expect(() => problem('Elsewhere')).toThrow('not in the workflow');
  });
});

describe('statusNameProblem', () => {
  it('accepts 1–50 characters after trimming', () => {
    expect(statusNameProblem('In Review')).toBeUndefined();
    expect(statusNameProblem(`  ${'x'.repeat(50)}  `)).toBeUndefined();
  });

  it('refuses an empty or too long name', () => {
    expect(statusNameProblem('   ')).toBe('Status name is required');
    expect(statusNameProblem('x'.repeat(51))).toBe(
      'Status name must be at most 50 characters long',
    );
  });
});

describe('statusLimitProblem (AC-13)', () => {
  it('allows the 50th status and refuses the 51st, naming the limit', () => {
    expect(STATUS_LIMIT).toBe(50);
    expect(statusLimitProblem(49)).toBeUndefined();
    expect(statusLimitProblem(50)).toBe('A team can have at most 50 statuses. Delete one first.');
  });
});
