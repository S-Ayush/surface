// Alt+Shift+T (shortcuts.md §3.1). Until the synced preference lands (PLAN-005 S7, AC-10), the toggle
// is local: it flips the rendered theme and caches the choice where the index.html bootstrap reads it.
import { THEME_STORAGE_KEY, resolveTheme, type Theme } from '@surface/ui';

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
