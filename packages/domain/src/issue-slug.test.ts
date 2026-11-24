// PLAN-011 S4, SPEC-011 §4.1 and AC-24: the cosmetic URL slug. It folds like the git branch name
// (`foldToSlug`, SPEC-012 D19), so the two never disagree.
import fc from 'fast-check';
import { propertyParameters } from '@surface/config/properties';
import { describe, expect, it } from 'vitest';
import { foldToSlug } from './git-branch.js';
import { issuePath, issueSlug, issueUrl, ISSUE_SLUG_MAX_LENGTH } from './issue.js';

describe('issueSlug (AC-24)', () => {
  it('gives lowercase words joined by hyphens, letters and digits only', () => {
    expect(issueSlug('Fix the Login page (again)!')).toBe('fix-the-login-page-again');
    expect(issueSlug('Crème brûlée für Straße 2')).toBe('creme-brulee-fur-strasse-2');
  });

  it('is empty for a title with no letters or digits', () => {
    expect(issueSlug('!!! ??? —')).toBe('');
    expect(issuePath('ENG-42', '???')).toBe('/issue/ENG-42');
  });

  it('cuts at 60 characters on a word boundary', () => {
    const title = 'Make the onboarding checklist remember which steps were skipped by admins';
    const slug = issueSlug(title);
    expect(slug).toBe('make-the-onboarding-checklist-remember-which-steps-were');
    expect(slug.length).toBeLessThanOrEqual(ISSUE_SLUG_MAX_LENGTH);
  });

  it('keeps a cut that falls exactly on a word boundary, and cuts a single long word', () => {
    const word = 'a'.repeat(59);
    expect(issueSlug(`${word}b cde`)).toBe(`${word}b`);
    expect(issueSlug('x'.repeat(80))).toBe('x'.repeat(60));
  });

  it('builds the path with the slug', () => {
    expect(issuePath('ENG-42', 'Fix login')).toBe('/issue/ENG-42/fix-login');
  });

  it('is at most 60 characters, a prefix of the folded title on a word boundary (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (title) => {
        const slug = issueSlug(title);
        const folded = foldToSlug(title);
        expect(slug.length).toBeLessThanOrEqual(ISSUE_SLUG_MAX_LENGTH);
        expect(slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
        expect(folded.startsWith(slug)).toBe(true);
        if (folded.length <= ISSUE_SLUG_MAX_LENGTH) expect(slug).toBe(folded);
        else if (folded.slice(0, ISSUE_SLUG_MAX_LENGTH).includes('-')) {
          // On a word boundary: the next character of the folded title is a hyphen.
          expect(folded[slug.length]).toBe('-');
        }
        expect(slug === '').toBe(!/[\p{L}\p{N}]/u.test(title) || folded === '');
      }),
      propertyParameters({ numRuns: 500 }),
    );
  });
});

describe('issueUrl (SPEC-011 §6.1, D11)', () => {
  it('appends the slugged path to the base, with or without a trailing slash', () => {
    const want = 'https://surface.example.com/issue/ENG-42/fix-login';
    expect(issueUrl('https://surface.example.com', 'ENG-42', 'Fix login')).toBe(want);
    expect(issueUrl('https://surface.example.com/', 'ENG-42', 'Fix login')).toBe(want);
  });

  it('keeps a base path, and drops the slug for a title without letters or digits', () => {
    expect(issueUrl('https://example.com/surface//', 'ENG-42', '???')).toBe(
      'https://example.com/surface/issue/ENG-42',
    );
  });
});
