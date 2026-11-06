import { describe, expect, it } from 'vitest';
import { isThemePreference, resolveTheme } from '../src/theme.js';

describe('resolveTheme', () => {
  it('uses an explicit light or dark preference regardless of the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the OS for "system", a missing value or garbage', () => {
    for (const preference of ['system', null, undefined, '', 'blue', 42]) {
      expect(resolveTheme(preference, true)).toBe('dark');
      expect(resolveTheme(preference, false)).toBe('light');
    }
  });
});

describe('isThemePreference', () => {
  it('accepts exactly light, dark and system', () => {
    expect(['light', 'dark', 'system'].every(isThemePreference)).toBe(true);
    expect([null, 'Dark', 'auto', 1].some(isThemePreference)).toBe(false);
  });
});
