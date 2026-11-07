// Putting the user's preferences on the page (SPEC-005 §6, E7; PLAN-005 S7). The synced row is
// the truth while signed in; this device's theme cache (`localStorage['surface.theme']`) follows
// it, so the next first paint matches, and holds the theme in force on pages without a store.
import type { FontSize, ThemePreferenceValue } from '@surface/operations';
import type { ThemePreference } from '@surface/ui';
import { reaction } from 'mobx';
import { structurallyEqual } from '../app/equal.js';
import {
  cachedThemePreference,
  setThemePreference,
  themePreference,
  type ThemeEnvironment,
} from '../theme/toggleTheme.js';

/** `html[data-font-size]` picks the root size (packages/ui styles/base.css); default has none. */
export const FONT_SIZE_ATTRIBUTE = 'data-font-size';

export type FontSizeRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function applyFontSize(root: FontSizeRoot, size: FontSize): void {
  if (size === 'default') root.removeAttribute(FONT_SIZE_ATTRIBUTE);
  else root.setAttribute(FONT_SIZE_ATTRIBUTE, size);
}

/** What the page shows from the replica: the saved theme (null if never chosen) and font size. */
export type ShownPreferences = {
  readonly theme: ThemePreferenceValue | null;
  readonly fontSize: FontSize;
};

export type PreferenceSource = {
  /** The user's preferences; undefined until the replica is ready. Observable (MobX). */
  read(): ShownPreferences | undefined;
  /** Saves a theme this device chose for a user who has none saved yet. */
  adopt(theme: ThemePreference): void;
};

/**
 * Applies the preferences `source` reads, now and whenever they change (another tab or device,
 * via sync: AC-10). Until the replica is ready nothing changes: the page keeps the cached theme.
 * A user who never saved a theme keeps the one this device chose (on the sign-in page, say),
 * which is then saved; with neither, it is System. Returns the disposer, which puts the default
 * font size back, so the signed-out pages don't keep one user's choice.
 */
export function followPreferences(
  source: PreferenceSource,
  theme: ThemeEnvironment,
  root: FontSizeRoot,
): () => void {
  const stop = reaction(
    () => source.read(),
    (shown) => {
      if (shown === undefined) return;
      const device = shown.theme === null ? cachedThemePreference(theme) : null;
      setThemePreference(theme, shown.theme ?? device ?? 'system');
      if (device !== null) source.adopt(device);
      applyFontSize(root, shown.fontSize);
    },
    { fireImmediately: true, equals: structurallyEqual },
  );
  return () => {
    stop();
    applyFontSize(root, 'default');
  };
}

/** `matchMedia('(prefers-color-scheme: dark)')`, as far as the listener needs it. */
export type ColorSchemeQuery = {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
};

/**
 * E7: with "System" in force, an OS theme change applies at once, without a reload. "In force"
 * is this device's cache, which the synced preference keeps current, so it works on every page,
 * signed in or not. Returns the disposer.
 */
export function followSystemTheme(theme: ThemeEnvironment, query: ColorSchemeQuery): () => void {
  const changed = () => {
    if (themePreference(theme) === 'system') setThemePreference(theme, 'system');
  };
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
}
