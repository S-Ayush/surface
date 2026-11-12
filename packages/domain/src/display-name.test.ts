import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameFrom,
  displayNameProblem,
  displayNameSuggestionPrefix,
  displayNameTakenMessage,
  suggestDisplayName,
} from './display-name.js';

describe('displayNameProblem', () => {
  it('accepts handles of letters, digits, dots, dashes and underscores', () => {
    for (const ok of ['iris', 'Ada.L', 'b_e-a', '7of9', ' iris ']) {
      expect(displayNameProblem(ok)).toBeUndefined();
    }
  });

  it('says what is wrong, and how to fix it', () => {
    expect(displayNameProblem('  ')).toBe('Display name is required');
    expect(displayNameProblem('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(
      'Display name must be at most 32 characters long',
    );
    for (const bad of ['ada lovelace', '@ada', '.ada', 'ädä']) {
      expect(displayNameProblem(bad)).toBe(
        'Display name can use letters, digits, dots, dashes and underscores, like ada.l',
      );
    }
  });
});

describe('displayNameFrom', () => {
  it('starts from the first word of the name, then the email', () => {
    expect(displayNameFrom('Ada Lovelace')).toBe('ada');
    expect(displayNameFrom('  Zoë  Ng')).toBe('zoe');
    expect(displayNameFrom('李', 'li.wei@example.com')).toBe('liwei');
    expect(displayNameFrom('', '')).toBe('member');
  });

  it('always gives a valid display name', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (name, email) => {
        expect(displayNameProblem(displayNameFrom(name, email))).toBeUndefined();
      }),
    );
  });
});

describe('suggestDisplayName (E5)', () => {
  it('suggests the first free number, ignoring case', () => {
    expect(suggestDisplayName('iris', ['iris'])).toBe('iris2');
    expect(suggestDisplayName('Iris', ['iris', 'IRIS2', 'iris3'])).toBe('Iris4');
    expect(displayNameTakenMessage('iris2')).toBe('That display name is taken. Try iris2');
  });

  it('suggests a valid display name that no one has', () => {
    const handle = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
    fc.assert(
      fc.property(handle, fc.array(handle, { maxLength: 20 }), (wanted, others) => {
        const taken = [wanted, `${wanted}2`, ...others];
        const suggestion = suggestDisplayName(wanted, taken);
        expect(displayNameProblem(suggestion)).toBeUndefined();
        expect(taken.map((t) => t.toLowerCase())).not.toContain(suggestion.toLowerCase());
      }),
    );
  });

  it('suggests only names that start with the lookup prefix, so the server sees them all', () => {
    const handle = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
    fc.assert(
      fc.property(handle, fc.integer({ min: 0, max: 200 }), (wanted, crowd) => {
        // `wanted` and its first `crowd` variants are taken, at any length.
        const taken = [wanted];
        for (let n = 2; n < crowd + 2; n += 1) taken.push(suggestDisplayName(wanted, taken));
        const prefix = displayNameSuggestionPrefix(wanted).toLowerCase();
        expect(suggestDisplayName(wanted, taken).toLowerCase().startsWith(prefix)).toBe(true);
        expect(taken.every((name) => name.toLowerCase().startsWith(prefix))).toBe(true);
      }),
    );
  });
});
