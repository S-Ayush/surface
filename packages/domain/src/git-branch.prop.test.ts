// SPEC-012 AC-10: branch names are lowercase ASCII, at most 60 characters, and stable.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BRANCH_NAME_MAX, gitBranchName } from './git-branch.js';

const identifier = fc
  .tuple(fc.stringMatching(/^[A-Z]{2,5}$/), fc.integer({ min: 1, max: 999_999 }))
  .map(([key, n]) => `${key}-${n}`);

describe('gitBranchName (properties)', () => {
  it('is lowercase ASCII (letters, digits, hyphens, one slash) and at most 60 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }),
        identifier,
        fc.string({ unit: 'binary' }),
        (name, id, slug) => {
          const branch = gitBranchName(name, id, slug);
          expect(branch.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
          expect(branch).toMatch(/^[a-z0-9/-]+$/);
          expect((branch.match(/\//g) ?? []).length).toBeLessThanOrEqual(1);
          expect(branch).not.toMatch(/--|-$|\/-|-\/|\/$/);
        },
      ),
    );
  });

  it('keeps the whole identifier whenever the prefix fits', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,12}$/), identifier, fc.string(), (name, id, slug) => {
        const branch = gitBranchName(name, id, slug);
        expect(branch.startsWith(`${name}/${id.toLowerCase()}`)).toBe(true);
      }),
    );
  });

  it('is stable: the same input gives the same name', () => {
    fc.assert(
      fc.property(fc.string(), identifier, fc.string(), (name, id, slug) => {
        expect(gitBranchName(name, id, slug)).toBe(gitBranchName(name, id, slug));
      }),
    );
  });
});
