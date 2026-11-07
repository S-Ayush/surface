// Alt+Shift+T (shortcuts.md §3.1). Until the synced preference lands (PLAN-005 S7, AC-10), the toggle
// is local: it flips the rendered theme and caches the choice where the index.html bootstrap reads it.
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

/** Switches between light and dark and returns the new theme. */
export function toggleTheme(env: ThemeEnvironment): Theme {
  const next: Theme = currentTheme(env) === 'dark' ? 'light' : 'dark';
  env.root.setAttribute('data-theme', next);
  try {
    env.storage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Quota or privacy errors only lose the first-paint cache.
  }
  return next;
}

/** The preference this device has cached: what the avatar menu's Theme ▸ shows as checked. */
export function themePreference(env: ThemeEnvironment): ThemePreference {
  try {
    const stored = env.storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a preference from the avatar menu (SPEC-005 §7). Local until the synced preference
 * lands (PLAN-005 S7). "System" follows the OS as of now; S7 adds the live listener (E7).
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
