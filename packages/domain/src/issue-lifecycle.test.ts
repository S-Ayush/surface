// PLAN-015 S1, SPEC-015 §4.1–§4.3: AC-1 (the transitions of §4.2 and the rule table's outcomes),
// AC-3 (`purgeAfter = deletedAt + 720 h`, restore 1 ms before it and not at it, no limit for an
// archived issue), the §4.2 messages.
import { describe, expect, it } from 'vitest';
import {
  canRestore,
  ISSUE_LIFECYCLE_RULES,
  ISSUE_LIFECYCLES,
  issueLockModeOf,
  lifecycleOf,
  lifecycleRefusal,
  lifecycleStep,
  lockRefusal,
  outcomeOf,
  purgeAfter,
  RETENTION_HOURS,
  type IssueLifecycle,
  type LifecycleStamps,
} from './issue-lifecycle.js';

const HOUR = 60 * 60 * 1000;
const DELETED_AT = new Date('2026-03-20T12:00:00.000Z');
const NOW = new Date('2026-03-21T08:00:00.000Z');

const stamps: Record<IssueLifecycle | 'archivedAndDeleted', LifecycleStamps<Date>> = {
  live: { archivedAt: null, deletedAt: null },
  archived: { archivedAt: new Date('2025-01-01T00:00:00.000Z'), deletedAt: null },
  deleted: { archivedAt: null, deletedAt: DELETED_AT },
  archivedAndDeleted: { archivedAt: new Date('2025-01-01T00:00:00.000Z'), deletedAt: DELETED_AT },
};

describe('lifecycleOf (§4.1)', () => {
  it('is deleted whenever deletedAt is set, whatever archivedAt is', () => {
    expect(lifecycleOf(stamps.live)).toBe('live');
    expect(lifecycleOf(stamps.archived)).toBe('archived');
    expect(lifecycleOf(stamps.deleted)).toBe('deleted');
    expect(lifecycleOf(stamps.archivedAndDeleted)).toBe('deleted');
    // The client holds ISO strings.
    expect(lifecycleOf({ archivedAt: '2026-01-01T00:00:00.000Z', deletedAt: null })).toBe(
      'archived',
    );
  });
});

describe('purgeAfter and canRestore (AC-3, D6)', () => {
  it('is deletedAt + 720 h, in UTC, whatever the clocks did in between', () => {
    expect(RETENTION_HOURS).toBe(720);
    // Europe's clocks go forward on 2026-03-29: 30 calendar days would be 719 h there.
    expect(purgeAfter(DELETED_AT).toISOString()).toBe('2026-04-19T12:00:00.000Z');
    expect(purgeAfter('2026-03-20T12:00:00.000Z').getTime() - DELETED_AT.getTime()).toBe(
      720 * HOUR,
    );
    expect(() => purgeAfter('yesterday')).toThrow('Not a timestamp');
  });

  it('restores a deleted issue 1 ms before purgeAfter, and not at it or after', () => {
    const boundary = purgeAfter(DELETED_AT).getTime();
    expect(canRestore(stamps.deleted, new Date(boundary - 1))).toBe(true);
    expect(canRestore(stamps.deleted, new Date(boundary))).toBe(false);
    expect(canRestore(stamps.deleted, new Date(boundary + 1))).toBe(false);
    // Deleted and archived: the same boundary.
    expect(canRestore(stamps.archivedAndDeleted, new Date(boundary - 1))).toBe(true);
    expect(canRestore(stamps.archivedAndDeleted, new Date(boundary))).toBe(false);
  });

  it('restores an archived issue with no time limit, and has nothing to restore on a live one', () => {
    expect(canRestore(stamps.archived, new Date('2040-01-01T00:00:00.000Z'))).toBe(true);
    expect(canRestore(stamps.live, NOW)).toBe(false);
  });

  it('reads the client’s ISO strings like the server’s dates', () => {
    const iso = { archivedAt: null, deletedAt: DELETED_AT.toISOString() };
    expect(canRestore(iso, new Date(purgeAfter(DELETED_AT).getTime() - 1))).toBe(true);
    expect(canRestore(iso, purgeAfter(DELETED_AT))).toBe(false);
  });
});

describe('lifecycleStep (§4.2)', () => {
  it('deletes a live or archived issue, keeping archivedAt, and does nothing to a deleted one', () => {
    expect(lifecycleStep('delete', stamps.live, NOW, NOW)).toEqual({
      kind: 'moves',
      to: 'deleted',
      stamps: { archivedAt: null, deletedAt: NOW },
    });
    expect(lifecycleStep('delete', stamps.archived, NOW, NOW)).toEqual({
      kind: 'moves',
      to: 'deleted',
      stamps: { archivedAt: stamps.archived.archivedAt, deletedAt: NOW },
    });
    expect(lifecycleStep('delete', stamps.deleted, NOW, NOW)).toEqual({ kind: 'noop' });
    expect(lifecycleStep('delete', stamps.archivedAndDeleted, NOW, NOW)).toEqual({ kind: 'noop' });
  });

  it('restores to Live, clearing both states, and does nothing to a live issue (D12)', () => {
    const live = { kind: 'moves', to: 'live', stamps: { archivedAt: null, deletedAt: null } };
    expect(lifecycleStep('restore', stamps.archived, NOW, NOW)).toEqual(live);
    expect(lifecycleStep('restore', stamps.deleted, NOW, NOW)).toEqual(live);
    expect(lifecycleStep('restore', stamps.archivedAndDeleted, NOW, NOW)).toEqual(live);
    expect(lifecycleStep('restore', stamps.live, NOW, NOW)).toEqual({ kind: 'noop' });
  });

  it('refuses a restore at or after purgeAfter, even before the job ran (E4)', () => {
    const at = purgeAfter(DELETED_AT);
    expect(lifecycleStep('restore', stamps.deleted, at, at)).toEqual({
      kind: 'conflict',
      conflict: 'expired',
    });
  });

  it('purges only a deleted issue', () => {
    expect(lifecycleStep('purge', stamps.deleted, NOW, NOW)).toEqual({ kind: 'purged' });
    expect(lifecycleStep('purge', stamps.live, NOW, NOW)).toEqual({
      kind: 'conflict',
      conflict: 'notDeleted',
    });
    expect(lifecycleStep('purge', stamps.archived, NOW, NOW)).toEqual({
      kind: 'conflict',
      conflict: 'notDeleted',
    });
  });

  it('refuses edits of archived and deleted issues, and lets cascades through in every state', () => {
    expect(lifecycleStep('edit', stamps.live, NOW, NOW)).toEqual({ kind: 'applies' });
    expect(lifecycleStep('edit', stamps.archived, NOW, NOW)).toEqual({
      kind: 'conflict',
      conflict: 'archived',
    });
    expect(lifecycleStep('edit', stamps.archivedAndDeleted, NOW, NOW)).toEqual({
      kind: 'conflict',
      conflict: 'deleted',
    });
    for (const state of Object.values(stamps)) {
      expect(lifecycleStep('cascade', state, NOW, NOW)).toEqual({ kind: 'applies' });
    }
  });

  it('archives only live issues (the job skips the others)', () => {
    expect(lifecycleStep('autoArchive', stamps.live, NOW, NOW)).toEqual({
      kind: 'moves',
      to: 'archived',
      stamps: { archivedAt: NOW, deletedAt: null },
    });
    expect(lifecycleStep('autoArchive', stamps.archived, NOW, NOW)).toEqual({ kind: 'skipped' });
    expect(lifecycleStep('autoArchive', stamps.deleted, NOW, NOW)).toEqual({ kind: 'skipped' });
  });
});

describe('the §4.2 messages', () => {
  it('words each refusal with the identifier', () => {
    expect(lifecycleRefusal('ENG-42', 'archived')).toBe(
      'ENG-42 is archived. Restore it to edit it.',
    );
    expect(lifecycleRefusal('ENG-42', 'deleted')).toBe(
      'ENG-42 was deleted. Restore it to edit it.',
    );
    expect(lifecycleRefusal('ENG-42', 'expired')).toBe(
      "ENG-42 was deleted more than 30 days ago and can't be restored.",
    );
    expect(lifecycleRefusal('ENG-42', 'notDeleted')).toBe('Delete ENG-42 first.');
  });

  it('refuses only in edit mode at the lock, and only outside Live', () => {
    expect(lockRefusal('edit', 'archived')).toBe('archived');
    expect(lockRefusal('edit', 'deleted')).toBe('deleted');
    expect(lockRefusal('edit', 'live')).toBeUndefined();
    for (const mode of ['lifecycle', 'cascade'] as const) {
      for (const state of ISSUE_LIFECYCLES) {
        expect(lockRefusal(mode, state)).toBeUndefined();
      }
    }
  });
});

describe('the lifecycle rule table (§4.3, AC-1)', () => {
  const sample: Record<IssueLifecycle, LifecycleStamps<Date>> = {
    live: stamps.live,
    archived: stamps.archived,
    deleted: stamps.deleted,
  };

  it.each(Object.entries(ISSUE_LIFECYCLE_RULES))(
    '%s: each state gets the outcome its row lists',
    (_operation, rule) => {
      for (const state of ISSUE_LIFECYCLES) {
        const step = lifecycleStep(rule.action, sample[state], NOW, NOW);
        expect(outcomeOf(rule.action, state, step), state).toBe(rule[state]);
      }
    },
  );

  it('gives every direct edit the edit mode and every transition the lifecycle mode', () => {
    for (const [operation, rule] of Object.entries(ISSUE_LIFECYCLE_RULES)) {
      const expected =
        rule.action === 'edit' ? 'edit' : rule.action === 'cascade' ? 'cascade' : 'lifecycle';
      expect(rule.mode, operation).toBe(expected);
    }
    expect(issueLockModeOf('issue.update')).toBe('edit');
    expect(issueLockModeOf('issue.delete')).toBe('lifecycle');
    expect(() => issueLockModeOf('issue.archive')).toThrow('no row in the lifecycle rule table');
  });

  it('has no archive or unarchive operation (D5)', () => {
    const names = Object.keys(ISSUE_LIFECYCLE_RULES);
    expect(names).not.toContain('issue.archive');
    expect(names).not.toContain('issue.unarchive');
  });
});
