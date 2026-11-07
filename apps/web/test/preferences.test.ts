// PLAN-005 S7: the user's preferences on the page (SPEC-005 §6). The synced theme and font size
// apply live, and the theme cache follows them (AC-10, unit part); "System" follows the OS live
// (E7); changes are `user.updatePreferences`, or this device only without a ready store; `/`
// opens the home view (SPEC-005 §3). AC-10 across tabs and devices is e2e (held).
import {
  THEME_PREFERENCES as OP_THEMES,
  userUpdatePreferences,
  type Preferences,
} from '@surface/operations';
import { THEME_PREFERENCES as UI_THEMES, THEME_STORAGE_KEY, overlayManager } from '@surface/ui';
import { InvalidInputError } from '@surface/sync-client';
import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it } from 'vitest';
import { homePath, homeTeamOf } from '../src/app/workspace.js';
import {
  FONT_SIZE_ATTRIBUTE,
  followPreferences,
  followSystemTheme,
  type ColorSchemeQuery,
  type PreferenceSource,
} from '../src/preferences/apply.js';
import { homeOptions, MY_ISSUES } from '../src/preferences/PreferencesScreen.js';
import {
  chooseTheme,
  savePreferences,
  toggleThemePreference,
  type PreferenceStore,
} from '../src/preferences/save.js';
import type { ThemeEnvironment } from '../src/theme/toggleTheme.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DES = '0192f0c1-7e5a-7b3c-9d4e-0000000000d1';

/** `<html>` and this device's storage. */
function page(shown: string | null, stored: string | null, systemDark = false) {
  const attrs = new Map<string, string>(shown === null ? [] : [['data-theme', shown]]);
  const storage = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
  const os = { dark: systemDark };
  const root = {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
  };
  const env: ThemeEnvironment = {
    root,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    systemPrefersDark: () => os.dark,
  };
  return { env, root, attrs, storage, os };
}

const prefs = (changes: Partial<Preferences> = {}): Preferences => ({
  theme: 'system',
  fontSize: 'default',
  homeTeamId: null,
  ...changes,
});

/** A ready store that records what it is asked to save. */
function recordingStore(fail?: string | Error) {
  const sent: unknown[] = [];
  const store: PreferenceStore = {
    dispatch: (op, input) => {
      if (fail !== undefined) throw typeof fail === 'string' ? new Error(fail) : fail;
      sent.push({ op: op.name, input });
      return Promise.resolve({ status: 'confirmed' });
    },
  };
  return { store, sent };
}

/** What the shell passes: the row's preferences (theme null when never saved), and saving. */
function source(
  read: () => (Omit<Preferences, 'theme'> & { theme: Preferences['theme'] | null }) | undefined,
  adopted: string[] = [],
): PreferenceSource {
  return {
    read: () => {
      const preferences = read();
      return preferences && { theme: preferences.theme, fontSize: preferences.fontSize };
    },
    adopt: (theme) => adopted.push(theme),
  };
}

const toasts = () => overlayManager.getSnapshot().visibleToasts.map((t) => t.message);

beforeEach(() => {
  overlayManager.clear();
});

describe('followPreferences (AC-10, unit part)', () => {
  it('applies the synced theme and font size, and caches the theme for the first paint', () => {
    const { env, root, attrs, storage } = page('light', 'light');
    const stop = followPreferences(
      source(() => prefs({ theme: 'dark', fontSize: 'large' })),
      env,
      root,
    );
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(attrs.get(FONT_SIZE_ATTRIBUTE)).toBe('large');
    stop();
  });

  it('follows a change from another tab or device, as sync delivers it', () => {
    const { env, root, attrs } = page('light', 'light');
    const current = observable.box(prefs({ theme: 'light', fontSize: 'small' }));
    const stop = followPreferences(
      source(() => current.get()),
      env,
      root,
    );
    expect(attrs.get(FONT_SIZE_ATTRIBUTE)).toBe('small');
    runInAction(() => current.set(prefs({ theme: 'dark', fontSize: 'default' })));
    expect(attrs.get('data-theme')).toBe('dark');
    // The default size is the stylesheet's own: no attribute.
    expect(attrs.has(FONT_SIZE_ATTRIBUTE)).toBe(false);
    stop();
  });

  it('keeps the cached theme until the replica is ready', () => {
    const { env, root, attrs, storage } = page('dark', 'dark');
    const current = observable.box<Preferences | undefined>(undefined);
    const stop = followPreferences(
      source(() => current.get()),
      env,
      root,
    );
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    runInAction(() => current.set(prefs({ theme: 'light' })));
    expect(attrs.get('data-theme')).toBe('light');
    stop();
  });

  it('puts the default font size back when the shell closes (sign-out)', () => {
    const { env, root, attrs } = page('light', 'light');
    const stop = followPreferences(
      source(() => prefs({ fontSize: 'large' })),
      env,
      root,
    );
    stop();
    expect(attrs.has(FONT_SIZE_ATTRIBUTE)).toBe(false);
  });

  it('keeps a theme this device chose before sign-in, and saves it, when the user has none (review m2)', () => {
    const { env, root, attrs, storage } = page('dark', 'dark');
    const adopted: string[] = [];
    const stop = followPreferences(
      source(() => ({ ...prefs(), theme: null }), adopted),
      env,
      root,
    );
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(adopted).toEqual(['dark']);
    stop();
  });

  it('uses System, saving nothing, when neither the user nor this device chose a theme', () => {
    const { env, root, attrs } = page(null, null, true);
    const adopted: string[] = [];
    const stop = followPreferences(
      source(() => ({ ...prefs(), theme: null }), adopted),
      env,
      root,
    );
    expect(attrs.get('data-theme')).toBe('dark');
    expect(adopted).toEqual([]);
    stop();
  });

  it('resolves "System" with the OS setting', () => {
    const { env, root, attrs, storage } = page('light', 'light', true);
    const stop = followPreferences(
      source(() => prefs({ theme: 'system' })),
      env,
      root,
    );
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('system');
    stop();
  });
});

describe('followSystemTheme (E7)', () => {
  function media() {
    const listeners = new Set<() => void>();
    const query: ColorSchemeQuery = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    return { query, listeners, change: () => listeners.forEach((listener) => listener()) };
  }

  it('applies an OS theme change at once while "System" is in force', () => {
    const { env, attrs, os } = page('light', 'system', false);
    const { query, change } = media();
    const stop = followSystemTheme(env, query);
    os.dark = true;
    change();
    expect(attrs.get('data-theme')).toBe('dark');
    stop();
  });

  it('ignores the OS when the user chose light or dark', () => {
    const { env, attrs, os } = page('light', 'light', false);
    const { query, change } = media();
    const stop = followSystemTheme(env, query);
    os.dark = true;
    change();
    expect(attrs.get('data-theme')).toBe('light');
    stop();
  });

  it('stops listening when disposed', () => {
    const { env } = page('light', 'system');
    const { query, listeners } = media();
    followSystemTheme(env, query)();
    expect(listeners.size).toBe(0);
  });
});

describe('changing a preference', () => {
  it('saves it with user.updatePreferences when the store is ready (AC-10)', () => {
    const { env, attrs } = page('light', 'light');
    const { store, sent } = recordingStore();
    chooseTheme(store, env, 'dark');
    expect(sent).toEqual([{ op: userUpdatePreferences.name, input: { theme: 'dark' } }]);
    // The optimistic update changes the row, and followPreferences applies it from there.
    expect(attrs.get('data-theme')).toBe('light');
  });

  it('applies it to this device only without a ready store (sign-in page, loading)', () => {
    const { env, attrs, storage } = page('light', 'light');
    chooseTheme(null, env, 'dark');
    expect(attrs.get('data-theme')).toBe('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('still applies it here, and says why, when the store refuses it', () => {
    const { env, attrs } = page('light', 'light');
    const { store } = recordingStore('Surface was updated. Reload the page to keep working.');
    chooseTheme(store, env, 'dark');
    expect(attrs.get('data-theme')).toBe('dark');
    expect(toasts()).toEqual(['Surface was updated. Reload the page to keep working.']);
  });

  it('returns why the store didn’t take a change', () => {
    expect(savePreferences(recordingStore().store, { fontSize: 'large' })).toBeNull();
    expect(savePreferences(recordingStore('Queue lost').store, { fontSize: 'large' })).toBe(
      'Queue lost',
    );
  });

  it('says only that it wasn’t saved when the error isn’t the store’s own message', () => {
    const notSaved = 'Your preference couldn’t be saved. Reload the page, then try again.';
    const invalid = new InvalidInputError('user.updatePreferences', [
      { path: ['theme'], message: 'Invalid option' },
    ]);
    expect(savePreferences(recordingStore(invalid).store, { fontSize: 'large' })).toBe(notSaved);
    const bug = new TypeError('Cannot read properties of undefined');
    expect(savePreferences(recordingStore(bug).store, { fontSize: 'large' })).toBe(notSaved);
  });
});

describe('Alt+Shift+T', () => {
  it('saves the other of light and dark from the theme on screen', () => {
    const { store, sent } = recordingStore();
    toggleThemePreference(store, page('dark', 'system', true).env);
    expect(sent).toEqual([{ op: userUpdatePreferences.name, input: { theme: 'light' } }]);
  });
});

describe('home view (SPEC-005 §3)', () => {
  // OPS is a public team the user can see but hasn't joined (review M1).
  const OPS = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
  const teams = [
    { id: ENG, key: 'ENG', name: 'Engineering', private: false },
    { id: OPS, key: 'OPS', name: 'Operations', private: false },
    { id: DES, key: 'DES', name: 'Design', private: true, $archived: true },
  ];

  it('opens the chosen team, or My issues by default', () => {
    expect(homePath(ENG, teams)).toBe('/team/ENG');
    expect(homePath(null, teams)).toBe('/my-issues');
  });

  it('opens a visible team the user isn’t a member of', () => {
    expect(homePath(OPS, teams)).toBe('/team/OPS');
    expect(homeTeamOf(OPS, teams)?.key).toBe('OPS');
  });

  it('opens My issues when the team is archived or no longer visible', () => {
    expect(homePath(DES, teams)).toBe('/my-issues');
    expect(homePath('0192f0c1-7e5a-7b3c-9d4e-0000000000ff', teams)).toBe('/my-issues');
    expect(homeTeamOf(DES, teams)).toBeUndefined();
  });

  it('offers My issues and the user’s teams, plus the home team when they aren’t in it', () => {
    const mine = [{ id: ENG, name: 'Engineering' }];
    expect(homeOptions(mine, undefined)).toEqual([
      { value: MY_ISSUES, label: 'My issues' },
      { value: ENG, label: 'Engineering' },
    ]);
    expect(homeOptions(mine, { id: ENG, name: 'Engineering' })).toEqual(
      homeOptions(mine, undefined),
    );
    expect(homeOptions(mine, { id: OPS, name: 'Operations' })).toEqual([
      { value: MY_ISSUES, label: 'My issues' },
      { value: ENG, label: 'Engineering' },
      { value: OPS, label: 'Operations' },
    ]);
  });
});

it('stores the same theme values the UI offers', () => {
  expect([...OP_THEMES]).toEqual([...UI_THEMES]);
});
