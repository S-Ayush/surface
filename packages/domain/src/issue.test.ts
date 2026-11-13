// PLAN-011 S3, SPEC-011 §4.1 and §6.4: issue titles (trimmed, line breaks become spaces, 1–255
// characters), priorities and identifiers; SPEC-015 §4.1–§4.3: the lifecycle state and the
// refusal an edit gets outside Live.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { editRefusal, lifecycleOf } from './issue-lifecycle.js';
import {
  isPriority,
  issueIdentifier,
  issueTitleProblem,
  ISSUE_TITLE_MAX_LENGTH,
  normalizeTitle,
} from './issue.js';
import { Issue } from './model/issue-models.js';

describe('normalizeTitle', () => {
  it('trims surrounding spaces and keeps inner ones', () => {
    expect(normalizeTitle('  Fix  the login  ')).toBe('Fix  the login');
  });

  it('replaces each line break with one space (Q5)', () => {
    expect(normalizeTitle('Fix\nthe\r\nlogin\rpage')).toBe('Fix the login page');
    expect(normalizeTitle('One\u2028two\u2029three')).toBe('One two three');
    expect(normalizeTitle('\nTrailing break\n')).toBe('Trailing break');
  });

  it('never leaves a line break, and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', ' ', '\n', '\r', '\u2028', 'é') }),
        (t) => {
          const once = normalizeTitle(t);
          expect(once).not.toMatch(/[\n\r\u2028\u2029]/);
          expect(normalizeTitle(once)).toBe(once);
        },
      ),
    );
  });
});

describe('issueTitleProblem', () => {
  it('requires a title after trimming', () => {
    expect(issueTitleProblem('')).toBe('Title is required.');
    expect(issueTitleProblem('   ')).toBe('Title is required.');
    expect(issueTitleProblem('\n\r\n')).toBe('Title is required.');
  });

  it('accepts 1 to 255 characters, counted as the user sees them', () => {
    expect(issueTitleProblem('a')).toBeUndefined();
    expect(issueTitleProblem('a'.repeat(ISSUE_TITLE_MAX_LENGTH))).toBeUndefined();
    // 255 emoji are 510 UTF-16 code units but 255 characters.
    expect(issueTitleProblem('🐛'.repeat(ISSUE_TITLE_MAX_LENGTH))).toBeUndefined();
    expect(issueTitleProblem(`  ${'a'.repeat(ISSUE_TITLE_MAX_LENGTH)}  `)).toBeUndefined();
  });

  it('refuses more than 255 characters with the §6.4 wording', () => {
    expect(issueTitleProblem('a'.repeat(256))).toBe('Title must be 255 characters or fewer.');
    expect(issueTitleProblem('🐛'.repeat(256))).toBe('Title must be 255 characters or fewer.');
  });
});

describe('isPriority', () => {
  it('accepts 0 to 4 only', () => {
    expect([0, 1, 2, 3, 4].every(isPriority)).toBe(true);
    for (const value of [-1, 5, 1.5, '1', null, undefined]) expect(isPriority(value)).toBe(false);
  });
});

describe('issueIdentifier', () => {
  it('joins the team key and the number', () => {
    expect(issueIdentifier('ENG', 42)).toBe('ENG-42');
  });
});

describe('lifecycleOf (SPEC-015 §4.1)', () => {
  it('is live, archived or deleted, and deleted wins over archived', () => {
    const at = '2026-11-13T10:00:00.000Z';
    expect(lifecycleOf({ archivedAt: null, deletedAt: null })).toBe('live');
    expect(lifecycleOf({ archivedAt: at, deletedAt: null })).toBe('archived');
    expect(lifecycleOf({ archivedAt: null, deletedAt: at })).toBe('deleted');
    expect(lifecycleOf({ archivedAt: new Date(at), deletedAt: new Date(at) })).toBe('deleted');
  });
});

describe('editRefusal (SPEC-011 §6.4)', () => {
  it('lets a live issue be edited and words the archived and deleted refusals', () => {
    expect(editRefusal('ENG-42', 'live')).toBeUndefined();
    expect(editRefusal('ENG-42', 'archived')).toBe('ENG-42 is archived. Restore it to edit it.');
    expect(editRefusal('ENG-42', 'deleted')).toBe('ENG-42 was deleted. Restore it to edit it.');
  });
});

describe('the Issue model', () => {
  it('takes a due date as a calendar date only', () => {
    const dueDate = Issue.fields['dueDate'];
    expect(dueDate?.type).toBe('day');
    expect(dueDate?.nullable).toBe(true);
    expect(dueDate?.schema.safeParse('2026-11-13').success).toBe(true);
    expect(dueDate?.schema.safeParse(null).success).toBe(true);
    for (const bad of ['2026-02-30', '2026-11-13T00:00:00Z', '13/11/2026', '']) {
      expect(dueDate?.schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('declares archive state and the lifecycle columns (SPEC-011 §4.1, §5.5)', () => {
    for (const field of ['archivedAt', 'deletedAt', 'deletedById', 'number', 'groups']) {
      expect(Issue.fields[field], field).toBeDefined();
    }
    expect(Issue.fields['archivedAt']?.nullable).toBe(true);
    expect(Issue.fields['number']?.nullable).toBe(true);
    expect(Issue.fields['creatorId']?.nullable).toBe(false);
  });
});
