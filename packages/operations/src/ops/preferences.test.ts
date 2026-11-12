// PLAN-005 S7: the shape of `UserPreferences.values` (SPEC-005 §6) and the optimistic update of
// `user.updatePreferences`. Rows written by the optimistic update must parse with the shared
// client model, or the client would drop them.
import { isUuid } from '@surface/domain';
import { UserPreferences } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  readPreferences,
  readSavedTheme,
  userUpdatePreferences,
} from './preferences.js';

const ME = '0192f0c1-7e5a-7b3c-9d4e-000000000001';
const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const NOW = new Date('2026-11-07T10:00:00.000Z');
const EARLIER = '2026-11-01T09:00:00.000Z';

/** Users resolve `me`, teams their key; preferences rows must parse with the client model. */
function fakeStore(preferences: StoreRow | undefined) {
  const rows = new Map<string, StoreRow>();
  if (preferences !== undefined) rows.set(ME, UserPreferences.rowSchema.parse(preferences));
  const writes: string[] = [];
  const store: OptimisticStore = {
    now: NOW,
    get: (model, ref) => {
      if (model === 'User') return ref === 'me' || ref === ME ? { id: ME } : undefined;
      if (model === 'Team')
        return ref === 'ENG' || ref === ENG ? { id: ENG, key: 'ENG' } : undefined;
      return model === 'UserPreferences' && isUuid(ref) ? rows.get(ref) : undefined;
    },
    patch: (model, ref, changes) => {
      const row = rows.get(ref);
      if (model !== 'UserPreferences' || row === undefined) return;
      writes.push('patch');
      rows.set(ref, UserPreferences.rowSchema.parse({ ...row, ...changes }));
    },
    insert: (model, row) => {
      if (model !== 'UserPreferences') return;
      writes.push('insert');
      rows.set(row.id, UserPreferences.rowSchema.parse(row));
    },
    find: () => [],
    archive: () => undefined,
    remove: () => undefined,
  };
  return { store, writes, row: () => rows.get(ME) };
}

const run = (store: OptimisticStore, input: unknown) =>
  userUpdatePreferences.optimistic?.(store, userUpdatePreferences.input.parse(input));

describe('readPreferences', () => {
  it('gives the defaults for an empty row: system theme, default size, My issues', () => {
    expect(readPreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: 'system', fontSize: 'default', homeTeamId: null });
  });

  it('reads each field on its own, so one bad value keeps the others', () => {
    expect(readPreferences({ theme: 'dark', fontSize: 'huge', homeTeamId: ENG })).toEqual({
      theme: 'dark',
      fontSize: 'default',
      homeTeamId: ENG,
    });
    expect(readPreferences({ theme: 'sepia', homeTeamId: 'ENG' })).toEqual(DEFAULT_PREFERENCES);
  });

  it('treats anything but an object as empty', () => {
    for (const values of [null, undefined, 'dark', 3, ['dark']]) {
      expect(readPreferences(values)).toEqual(DEFAULT_PREFERENCES);
    }
  });
});

describe('readSavedTheme', () => {
  it('is null until the user saves a theme, so the device’s choice can be kept (review m2)', () => {
    expect(readSavedTheme({})).toBeNull();
    expect(readSavedTheme({ theme: 'sepia' })).toBeNull();
    expect(readSavedTheme(null)).toBeNull();
    expect(readSavedTheme({ theme: 'dark' })).toBe('dark');
  });
});

describe('mergePreferences', () => {
  it('changes only the given preferences and keeps keys this version doesn’t know', () => {
    const values = { theme: 'light', density: 'compact' };
    expect(mergePreferences(values, { fontSize: 'large', theme: undefined })).toEqual({
      theme: 'light',
      density: 'compact',
      fontSize: 'large',
    });
    expect(values).toEqual({ theme: 'light', density: 'compact' });
  });

  it('can set the home back to My issues', () => {
    expect(mergePreferences({ homeTeamId: ENG }, { homeTeamId: null })).toEqual({
      homeTeamId: null,
    });
  });
});

describe('user.updatePreferences input', () => {
  it('takes any subset, a team key or id for the home, or null for My issues', () => {
    expect(userUpdatePreferences.input.parse({})).toEqual({});
    expect(userUpdatePreferences.input.parse({ homeTeam: null })).toEqual({ homeTeam: null });
    expect(userUpdatePreferences.input.parse({ homeTeam: 'ENG' })).toEqual({ homeTeam: 'ENG' });
  });

  it('refuses themes and sizes it doesn’t know', () => {
    expect(userUpdatePreferences.input.safeParse({ theme: 'sepia' }).success).toBe(false);
    expect(userUpdatePreferences.input.safeParse({ fontSize: 16 }).success).toBe(false);
  });
});

describe('user.updatePreferences optimistic update', () => {
  const existing = {
    id: ME,
    values: { theme: 'light', density: 'compact' },
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };

  it('patches the user’s row, keeping the other preferences', () => {
    const { store, writes, row } = fakeStore(existing);
    run(store, { theme: 'dark', homeTeam: 'ENG' });
    expect(writes).toEqual(['patch']);
    expect(row()).toMatchObject({
      values: { theme: 'dark', density: 'compact', homeTeamId: ENG },
      updatedAt: NOW.toISOString(),
    });
  });

  it('inserts the row when the user has none yet', () => {
    const { store, writes, row } = fakeStore(undefined);
    run(store, { fontSize: 'small' });
    expect(writes).toEqual(['insert']);
    expect(row()).toMatchObject({ id: ME, values: { fontSize: 'small' } });
  });

  it('leaves a home team it can’t find to the server, and still applies the rest', () => {
    const { store, row } = fakeStore(existing);
    run(store, { theme: 'system', homeTeam: 'NOPE' });
    expect(row()?.['values']).toEqual({ theme: 'system', density: 'compact' });
  });

  it('sets the home back to My issues with null', () => {
    const { store, row } = fakeStore({ ...existing, values: { homeTeamId: ENG } });
    run(store, { homeTeam: null });
    expect(row()?.['values']).toEqual({ homeTeamId: null });
  });
});
