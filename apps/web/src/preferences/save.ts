// Changing the user's preferences (SPEC-005 §6; PLAN-005 S7). Every change is `user.updatePreferences`
// (CLAUDE.md rule 1): its optimistic update shows it at once (followPreferences applies it), and
// a later refusal is the shell's rejection toast (SPEC-002 §3.5).
import { userUpdatePreferences, type AnyOperation, type InputOf } from '@surface/operations';
import type { MutationOutcome } from '@surface/sync-client';
import { toast, type ThemePreference } from '@surface/ui';
import { currentTheme, setThemePreference, type ThemeEnvironment } from '../theme/toggleTheme.js';

export type PreferenceChange = InputOf<typeof userUpdatePreferences>;

/** A store whose replica is ready: the part saving needs. */
export type PreferenceStore = {
  dispatch<Op extends AnyOperation>(op: Op, input: InputOf<Op>): Promise<MutationOutcome>;
};

const NOT_SAVED = 'Your preference couldn’t be saved. Reload the page, then try again.';

/** Saves `change`; returns why the store didn't take it, or null. */
export function savePreferences(store: PreferenceStore, change: PreferenceChange): string | null {
  try {
    // A refusal is the shell's toast; keep the promise from going unhandled.
    store.dispatch(userUpdatePreferences, change).catch(() => undefined);
    return null;
  } catch (error) {
    // The store refuses with a plain Error whose message says what to do (outdated, queue lost,
    // not loaded). Anything else, such as an InvalidInputError, is a bug: don't show its text.
    return error instanceof Error && error.name === 'Error' ? error.message : NOT_SAVED;
  }
}

/**
 * A theme from the avatar menu or the preferences screen. With a ready store it is saved, and
 * syncs to the user's other tabs and devices (AC-10); without one (the sign-in page, a workspace
 * still loading) it applies to this device only, as before S7.
 */
export function chooseTheme(
  store: PreferenceStore | null,
  env: ThemeEnvironment,
  preference: ThemePreference,
): void {
  const problem = store === null ? null : savePreferences(store, { theme: preference });
  if (store === null || problem !== null) setThemePreference(env, preference);
  if (problem !== null) toast({ tone: 'danger', message: problem });
}

/** Alt+Shift+T (shortcuts.md §3.1): the other of light and dark from the one on screen. */
export function toggleThemePreference(store: PreferenceStore | null, env: ThemeEnvironment): void {
  chooseTheme(store, env, currentTheme(env) === 'dark' ? 'light' : 'dark');
}
