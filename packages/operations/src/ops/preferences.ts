/**
 * The user's own preferences (SPEC-005 §6; PLAN-005 S7): theme, font size and home view, stored
 * in the `UserPreferences` row (id = the user's id, synced only to `user:<id>`). This file owns
 * the shape of its `values` json.
 *
 * Density is deferred (SPEC-005 §2, 2026-11-07). A value this version doesn't know, like a
 * preference a newer client wrote, is kept as it is when another one changes.
 */
import { TeamRef } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';

/** Same values as `ThemePreference` in `@surface/ui` (a web test keeps them equal). */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreferenceValue = (typeof THEME_PREFERENCES)[number];

/** 12, 13 and 14 px roots (design-system §3). */
export const FONT_SIZES = ['small', 'default', 'large'] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const PreferencesSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  fontSize: z.enum(FONT_SIZES),
  /** The team `/` opens; null opens My issues (SPEC-005 §3). */
  homeTeamId: z.uuid().nullable(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  fontSize: 'default',
  homeTeamId: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The theme the user saved, or null if they never chose one (a new row): the shell then keeps
 * the theme this device chose before sign-in, and saves it (SPEC-005 §6).
 */
export function readSavedTheme(values: unknown): ThemePreferenceValue | null {
  const theme = PreferencesSchema.shape.theme.safeParse(
    isRecord(values) ? values['theme'] : undefined,
  );
  return theme.success ? theme.data : null;
}

/**
 * The preferences in a `values` json. Each field is read on its own: one missing or not valid
 * (an empty row, a value from another version) falls back to its default, not the whole set.
 */
export function readPreferences(values: unknown): Preferences {
  const record = isRecord(values) ? values : {};
  const { shape } = PreferencesSchema;
  const fontSize = shape.fontSize.safeParse(record['fontSize']);
  const homeTeamId = shape.homeTeamId.safeParse(record['homeTeamId']);
  return {
    theme: readSavedTheme(values) ?? DEFAULT_PREFERENCES.theme,
    fontSize: fontSize.success ? fontSize.data : DEFAULT_PREFERENCES.fontSize,
    homeTeamId: homeTeamId.success ? homeTeamId.data : DEFAULT_PREFERENCES.homeTeamId,
  };
}

/** `values` with `changes` applied; keys this version doesn't know are kept. */
export function mergePreferences(
  values: unknown,
  changes: Partial<Preferences>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(values) ? { ...values } : {};
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

const idOf = (row: StoreRow | undefined): string | undefined =>
  typeof row?.['id'] === 'string' ? row['id'] : undefined;

/** The home change the store can predict: a team it doesn't know is left to the server. */
function predictedHome(
  store: OptimisticStore,
  homeTeam: string | null | undefined,
): Pick<Partial<Preferences>, 'homeTeamId'> {
  if (homeTeam === undefined) return {};
  if (homeTeam === null) return { homeTeamId: null };
  const teamId = idOf(store.get('Team', homeTeam));
  return teamId === undefined ? {} : { homeTeamId: teamId };
}

export const userUpdatePreferences = defineOperation({
  name: 'user.updatePreferences',
  kind: 'mutation',
  domain: 'user',
  summary: 'Update your preferences',
  description:
    'Changes your own theme (light, dark or system), font size (small, default or large) or home view: the team that opens first, by key like ENG or id, or null for My issues. Only the given preferences change.',
  keywords: ['change theme', 'dark mode', 'light mode', 'font size', 'text size', 'home page'],
  input: z.object({
    theme: z.enum(THEME_PREFERENCES).optional(),
    fontSize: z.enum(FONT_SIZES).optional(),
    homeTeam: TeamRef.nullable().optional(),
  }),
  output: PreferencesSchema,
  // Anyone signed in, for their own row only: the handler writes the actor's preferences.
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ theme: 'dark' }, { fontSize: 'large', homeTeam: 'ENG' }, { homeTeam: null }],
  optimistic: (store, input) => {
    const me = idOf(store.get('User', 'me'));
    if (me === undefined) return;
    const changes: Partial<Preferences> = {
      ...(input.theme === undefined ? {} : { theme: input.theme }),
      ...(input.fontSize === undefined ? {} : { fontSize: input.fontSize }),
      ...predictedHome(store, input.homeTeam),
    };
    const now = store.now.toISOString();
    const row = store.get('UserPreferences', me);
    const values = mergePreferences(row?.['values'], changes);
    if (row === undefined) {
      store.insert('UserPreferences', { id: me, values, createdAt: now, updatedAt: now });
    } else {
      store.patch('UserPreferences', me, { values, updatedAt: now });
    }
  },
});
