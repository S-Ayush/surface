// Theme preference resolution (SPEC-005 §6, FR-AUTH-10). The inline bootstrap script in
// apps/web/index.html mirrors resolveTheme() so the first paint already has the right theme; a test
// runs that script against this function.
import type { Theme } from './tokens.gen.js';

/** localStorage key caching the user's theme preference on this device. */
export const THEME_STORAGE_KEY = 'surface.theme';

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

/** The theme to render: an explicit preference wins; "system" or anything unknown follows the OS. */
export function resolveTheme(preference: unknown, systemPrefersDark: boolean): Theme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}
