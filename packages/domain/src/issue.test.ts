// PLAN-011 S3, SPEC-011 §4.1 and §6.4: issue titles (trimmed, line breaks become spaces, 1–255
// characters), priorities and identifiers; SPEC-015 §4.1–§4.3: the lifecycle state and the
// refusal an edit gets outside Live.
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { editRefusal, lifecycleOf } from './issue-lifecycle.js';
import {
  ARCHIVED_LABEL_MESSAGE,
  inv20Problem,
  isPriority,
  issueChangeSet,
  issueEstimateProblem,
  issueIdentifier,
  issueLabelProblem,
  issueStatusProblem,
  issueTitleProblem,
  ISSUE_LABEL_LIMIT,
  ISSUE_TITLE_MAX_LENGTH,
  mergeLabels,
  normalizeTitle,
  statusSideEffects,
  type CategoryTimestamps,
  type IssueEditValues,
  type IssueLabelFacts,
} from './issue.js';
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';
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

// PLAN-011 S4: status side effects (AC-3), label rules (AC-4, AC-16, E5–E7), change sets (E12).

const NONE: CategoryTimestamps<string> = { startedAt: null, completedAt: null, canceledAt: null };
const T0 = '2026-11-01T00:00:00.000Z';
const NOW = '2026-11-13T10:00:00.000Z';

describe('statusSideEffects (SPEC-011 §4.6, AC-3)', () => {
  const was = { startedAt: T0, completedAt: T0, canceledAt: null };

  it('changes nothing within one category, so moving between Completed statuses keeps completedAt', () => {
    expect(statusSideEffects('completed', 'completed', NOW, was)).toBe(was);
  });

  it('into Started sets startedAt if null and clears completedAt and canceledAt', () => {
    expect(statusSideEffects('backlog', 'started', NOW, NONE)).toEqual({
      startedAt: NOW,
      completedAt: null,
      canceledAt: null,
    });
    expect(statusSideEffects('completed', 'started', NOW, was)).toEqual({
      startedAt: T0,
      completedAt: null,
      canceledAt: null,
    });
  });

  it('into Completed sets completedAt and clears canceledAt, keeping startedAt', () => {
    expect(
      statusSideEffects('canceled', 'completed', NOW, { ...NONE, startedAt: T0, canceledAt: T0 }),
    ).toEqual({ startedAt: T0, completedAt: NOW, canceledAt: null });
  });

  it('into Canceled sets canceledAt and clears completedAt', () => {
    expect(statusSideEffects('completed', 'canceled', NOW, was)).toEqual({
      startedAt: T0,
      completedAt: null,
      canceledAt: NOW,
    });
  });

  it('a reopen into Backlog or Unstarted clears the closing timestamps and keeps startedAt', () => {
    for (const to of ['backlog', 'unstarted'] as const) {
      expect(statusSideEffects('completed', to, NOW, was)).toEqual({
        startedAt: T0,
        completedAt: null,
        canceledAt: null,
      });
    }
  });

  it('a create applies the side effects of its initial category', () => {
    expect(statusSideEffects(null, 'started', NOW, NONE).startedAt).toBe(NOW);
    expect(statusSideEffects(null, 'completed', NOW, NONE).completedAt).toBe(NOW);
    expect(statusSideEffects(null, 'backlog', NOW, NONE)).toEqual(NONE);
  });

  it('refuses Triage and Duplicate, and nothing else', () => {
    const allowed = STATUS_CATEGORIES.filter((c) => issueStatusProblem(c) === undefined);
    expect(allowed).toEqual(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
    expect(issueStatusProblem('triage')).toBe('Triage and Duplicate are set by their own actions.');
    expect(issueStatusProblem('duplicate')).toBe(
      'Triage and Duplicate are set by their own actions.',
    );
  });

  it('INV-20 holds after any sequence of status changes, starting from any create (property)', () => {
    const settable = fc.constantFrom<StatusCategory>(
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    );
    fc.assert(
      fc.property(settable, fc.array(settable, { maxLength: 30 }), (first, moves) => {
        let clock = 0;
        let category = first;
        let stamps = statusSideEffects<number>(null, first, clock, {
          startedAt: null,
          completedAt: null,
          canceledAt: null,
        });
        expect(inv20Problem(stamps, category)).toBeUndefined();
        let everStarted = category === 'started';
        for (const next of moves) {
          clock += 1;
          const before = stamps;
          stamps = statusSideEffects(category, next, clock, stamps);
          if (next === category) expect(stamps).toBe(before);
          category = next;
          everStarted ||= category === 'started';
          expect(inv20Problem(stamps, category)).toBeUndefined();
          // Once started, startedAt stays set in any category.
          if (everStarted) expect(stamps.startedAt).not.toBeNull();
        }
      }),
      propertyParameters({ numRuns: 500 }),
    );
  });
});

describe('inv20Problem', () => {
  it('names each broken rule', () => {
    expect(inv20Problem(NONE, 'completed')).toBeDefined();
    expect(inv20Problem({ ...NONE, completedAt: T0, canceledAt: T0 }, 'completed')).toBeDefined();
    expect(inv20Problem(NONE, 'canceled')).toBeDefined();
    expect(inv20Problem(NONE, 'started')).toBeDefined();
    expect(inv20Problem({ ...NONE, completedAt: T0 }, 'backlog')).toBeDefined();
    expect(inv20Problem({ ...NONE, startedAt: T0 }, 'backlog')).toBeUndefined();
  });
});

const ENG = 'team-eng';

function label(id: string, extra: Partial<IssueLabelFacts> = {}): IssueLabelFacts {
  return {
    id,
    name: id,
    teamId: ENG,
    isGroup: false,
    parentId: null,
    exclusive: true,
    archivedAt: null,
    ...extra,
  };
}

function labelMap(...labels: IssueLabelFacts[]): Map<string, IssueLabelFacts> {
  return new Map(labels.map((l) => [l.id, l]));
}

describe('issueLabelProblem (SPEC-011 §4.2, INV-06, SPEC-010 E12, E13)', () => {
  const size = label('size', { isGroup: true, name: 'Size' });
  const archivedGroup = label('scope', { isGroup: true, archivedAt: T0 });
  const labels = labelMap(size, archivedGroup);

  it("accepts a label of the issue's team and a workspace label", () => {
    expect(issueLabelProblem(label('bug'), ENG, 'ENG', labels)).toBeUndefined();
    expect(issueLabelProblem(label('ws', { teamId: null }), ENG, 'ENG', labels)).toBeUndefined();
  });

  it("refuses another team's label (INV-06)", () => {
    expect(issueLabelProblem(label('des', { teamId: 'team-des' }), ENG, 'ENG', labels)).toBe(
      'That label belongs to another team. Use a label of ENG or a workspace label.',
    );
  });

  it('refuses a group', () => {
    expect(issueLabelProblem(size, ENG, 'ENG', labels)).toBe(
      'Size is a label group. Choose one of its labels.',
    );
  });

  it('refuses an archived label and a label in an archived group', () => {
    expect(issueLabelProblem(label('old', { archivedAt: T0 }), ENG, 'ENG', labels)).toBe(
      ARCHIVED_LABEL_MESSAGE,
    );
    expect(issueLabelProblem(label('x', { parentId: 'scope' }), ENG, 'ENG', labels)).toBe(
      ARCHIVED_LABEL_MESSAGE,
    );
  });
});

describe('mergeLabels (SPEC-011 §4.2, AC-4, AC-16, E5–E7)', () => {
  const size = label('size', { isGroup: true });
  const small = label('small', { parentId: 'size' });
  const large = label('large', { parentId: 'size' });
  const area = label('area', { isGroup: true, exclusive: false });
  const ui = label('ui', { parentId: 'area' });
  const api = label('api', { parentId: 'area' });
  const bug = label('bug');
  const labels = labelMap(size, small, large, area, ui, api, bug);

  const merged = (current: string[], add: string[], remove: string[] = []) => {
    const result = mergeLabels(current, add, remove, labels);
    if (!result.ok) throw new Error(result.problem);
    return result.labelIds;
  };

  it('adds and removes, keeping insertion order', () => {
    expect(merged(['bug'], ['ui'])).toEqual(['bug', 'ui']);
    expect(merged(['bug', 'ui'], [], ['bug'])).toEqual(['ui']);
  });

  it('a duplicate add and a remove of a missing label are no-ops (E7)', () => {
    expect(merged(['bug'], ['bug'], ['ui'])).toEqual(['bug']);
  });

  it('an add of an exclusive group replaces the issue’s other label of it; a multi-select group keeps both', () => {
    expect(merged(['small', 'bug'], ['large'])).toEqual(['bug', 'large']);
    expect(merged(['ui'], ['api'])).toEqual(['ui', 'api']);
  });

  it('a label moved into an exclusive group keeps both until the next add of that group (AC-16)', () => {
    // Two labels of the group, applied before they were grouped: no add of the group, both stay.
    expect(merged(['small', 'large'], ['bug'])).toEqual(['small', 'large', 'bug']);
    // The next add of a label of the group removes the others.
    const medium = label('medium', { parentId: 'size' });
    const result = mergeLabels(
      ['small', 'large'],
      ['medium'],
      [],
      labelMap(...labels.values(), medium),
    );
    expect(result).toEqual({ ok: true, labelIds: ['medium'] });
  });

  it(`refuses more than ${ISSUE_LABEL_LIMIT} labels`, () => {
    const many = Array.from({ length: ISSUE_LABEL_LIMIT }, (_, i) => `l${i}`);
    expect(mergeLabels(many, ['bug'], [], labels)).toEqual({
      ok: false,
      problem: 'An issue can have up to 20 labels. Remove one first.',
    });
    expect(mergeLabels(many, ['bug'], ['l0'], labels).ok).toBe(true);
  });

  it('never leaves two labels of an exclusive group that one write added, nor more than the limit, nor a duplicate (property)', () => {
    const ids = [...labels.keys()].filter((id) => labels.get(id)?.isGroup === false);
    const id = fc.constantFrom(...ids);
    fc.assert(
      fc.property(
        fc.uniqueArray(id, { maxLength: 5 }),
        fc.array(id, { maxLength: 5 }),
        fc.array(id, { maxLength: 5 }),
        (current, add, remove) => {
          const addSet = add.filter((a) => !remove.includes(a));
          const result = mergeLabels(current, addSet, remove, labels);
          if (!result.ok) return;
          const out = result.labelIds;
          expect(new Set(out).size).toBe(out.length);
          expect(out.length).toBeLessThanOrEqual(ISSUE_LABEL_LIMIT);
          for (const r of remove) expect(out).not.toContain(r);
          for (const a of addSet) {
            // Each add is on the issue unless a later add of the same exclusive group replaced it.
            const group = labels.get(a)?.parentId;
            const later = addSet.slice(addSet.lastIndexOf(a) + 1);
            const replaced =
              group === 'size' && later.some((b) => labels.get(b)?.parentId === 'size');
            if (!replaced && !current.includes(a)) expect(out).toContain(a);
          }
          // An add of the exclusive group leaves exactly one label of it.
          if (addSet.some((a) => labels.get(a)?.parentId === 'size' && !current.includes(a))) {
            expect(out.filter((o) => labels.get(o)?.parentId === 'size')).toHaveLength(1);
          }
        },
      ),
      propertyParameters({ numRuns: 500 }),
    );
  });
});

describe('issueChangeSet (SPEC-011 E12)', () => {
  const before: IssueEditValues = {
    title: 'Fix login',
    statusId: 's1',
    priority: 0,
    assigneeId: null,
    labelIds: ['a', 'b'],
    estimate: null,
    dueDate: null,
  };

  it('is empty when nothing differs, labels compared as the stored array', () => {
    expect(issueChangeSet(before, { ...before, labelIds: ['a', 'b'] })).toEqual({});
  });

  it('names each changed field with from and to', () => {
    expect(issueChangeSet(before, { ...before, priority: 2, labelIds: ['a'] })).toEqual({
      priority: { from: 0, to: 2 },
      labelIds: { from: ['a', 'b'], to: ['a'] },
    });
  });
});

describe('issueEstimateProblem (SPEC-011 §6.4, E8)', () => {
  const config = (scale: 'off' | 'linear' | 'fibonacci' | 'tshirt', allowZero = false) => ({
    scale,
    extended: false,
    allowZero,
  });

  it('always allows clearing the estimate', () => {
    for (const scale of ['off', 'linear', 'fibonacci', 'tshirt'] as const) {
      expect(issueEstimateProblem(config(scale), 'ENG', null)).toBeUndefined();
    }
  });

  it('refuses any value while the team has estimates off, saying how to fix it', () => {
    expect(issueEstimateProblem(config('off'), 'ENG', 3)).toBe(
      "ENG doesn't use estimates. Turn them on in team settings, or leave the estimate empty.",
    );
  });

  it('names the scale and its values for a value off the scale', () => {
    expect(issueEstimateProblem(config('fibonacci'), 'ENG', 4)).toBe(
      "4 is not on ENG's fibonacci scale (1, 2, 3, 5, 8).",
    );
    expect(issueEstimateProblem(config('linear'), 'DES', 0)).toBe(
      "0 is not on DES's linear scale (1, 2, 3, 4, 5).",
    );
    expect(issueEstimateProblem(config('tshirt'), 'ENG', 4)).toMatch(/ENG's t-shirt scale/);
  });

  it('accepts every value on the scale, and 0 only with Allow zero', () => {
    for (const value of [1, 2, 3, 5, 8]) {
      expect(issueEstimateProblem(config('fibonacci'), 'ENG', value)).toBeUndefined();
    }
    expect(issueEstimateProblem(config('linear', true), 'ENG', 0)).toBeUndefined();
  });
});
