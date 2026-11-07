// The theme on this page: the rendered `data-theme` and this device's cache, which the index.html
// bootstrap reads for the first paint. Choosing a theme saves the synced preference when it can
// (preferences/save.ts); these functions apply it here.
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from '@surface/ui';

export type ThemeEnvironment = {
  readonly root: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  readonly storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  } | null;
  readonly systemPrefersDark: () => boolean;
};

export function browserThemeEnvironment(): ThemeEnvironment {
  let storage: ThemeEnvironment['storage'] = null;
  try {
    storage = window.localStorage;
  } catch {
    // Storage can be blocked (privacy settings); the toggle still works for this page.
  }
  return {
    root: document.documentElement,
    storage,
    systemPrefersDark: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  };
}

/** The theme on screen now: the attribute the bootstrap set, else the resolved preference. */
export function currentTheme(env: ThemeEnvironment): Theme {
  const shown = env.root.getAttribute('data-theme');
  if (shown === 'light' || shown === 'dark') return shown;
  let stored: string | null;
  try {
    stored = env.storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return resolveTheme(stored, env.systemPrefersDark());
}

/** The preference this device cached, or null if it never chose one. */
export function cachedThemePreference(env: ThemeEnvironment): ThemePreference | null {
  try {
    const stored = env.storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The preference this device has cached: what the avatar menu's Theme ▸ shows as checked. */
export function themePreference(env: ThemeEnvironment): ThemePreference {
  return cachedThemePreference(env) ?? 'system';
}

/**
 * Applies a theme preference to this page and caches it. "System" resolves with the OS as of
 * now; `followSystemTheme` (preferences/apply.ts) re-applies it when the OS changes (E7).
 */
export function setThemePreference(env: ThemeEnvironment, preference: ThemePreference): Theme {
  const theme = resolveTheme(preference, env.systemPrefersDark());
  env.root.setAttribute('data-theme', theme);
  try {
    env.storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Quota or privacy errors only lose the first-paint cache.
  }
  return theme;
}
