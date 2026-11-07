import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from '@surface/ui';
import { toggleThemePreference } from '../src/preferences/save.js';
import {
  setThemePreference,
  themePreference,
  type ThemeEnvironment,
} from '../src/theme/toggleTheme.js';

/** Alt+Shift+T with no ready store (the sign-in page, a workspace loading): this device only. */
function toggleTheme(env: ThemeEnvironment): string | null {
  toggleThemePreference(null, env);
  return env.root.getAttribute('data-theme');
}

function environment(shown: string | null, stored: string | null, systemDark = false) {
  const attrs = new Map<string, string>(shown === null ? [] : [['data-theme', shown]]);
  const storage = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
  const env: ThemeEnvironment = {
    root: {
      getAttribute: (name) => attrs.get(name) ?? null,
      setAttribute: (name, value) => attrs.set(name, value),
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    systemPrefersDark: () => systemDark,
  };
  return { env, attrs, storage };
}

describe('Alt+Shift+T theme toggle without a store', () => {
  it('flips the theme on screen and caches it for the first-paint bootstrap', () => {
    const { env, attrs, storage } = environment('light', 'system');
    expect(toggleTheme(env)).toBe('dark');
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(toggleTheme(env)).toBe('light');
  });

  it('resolves the current theme when the attribute is missing', () => {
    expect(toggleTheme(environment(null, null, true).env)).toBe('light');
    expect(toggleTheme(environment(null, 'dark').env)).toBe('light');
    expect(toggleTheme(environment(null, null, false).env)).toBe('dark');
  });

  it('still switches when storage is unavailable or throws', () => {
    const { env, attrs } = environment('dark', null);
    expect(toggleTheme({ ...env, storage: null })).toBe('light');
    const throwing: ThemeEnvironment = {
      ...env,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    };
    expect(toggleTheme(throwing)).toBe('dark');
    expect(attrs.get('data-theme')).toBe('dark');
  });
});

describe('Theme ▸ applied on this device', () => {
  it('applies light, dark or system and caches the preference', () => {
    const { env, attrs, storage } = environment('light', null, true);
    expect(themePreference(env)).toBe('system');
    expect(setThemePreference(env, 'light')).toBe('light');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
    expect(setThemePreference(env, 'system')).toBe('dark'); // the OS prefers dark
    expect(attrs.get('data-theme')).toBe('dark');
    expect(themePreference(env)).toBe('system');
  });
});
