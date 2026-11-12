// PLAN-001 S6, AC-15: `user.updateProfile` predicts its change in the signed-in user's row, so
// it shows at once here and, once confirmed, in every other client (the e2e test is held).
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { userUpdateProfile } from './profile.js';

const ME = '0192f0c1-7e5a-7b3c-9d4e-000000000001';
const FILE = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-12T10:00:00.000Z');

function fakeStore(signedIn = true) {
  const patches: { model: string; ref: string; changes: StoreRow }[] = [];
  const store: OptimisticStore = {
    now: NOW,
    get: (model, ref) => (signedIn && model === 'User' && ref === 'me' ? { id: ME } : undefined),
    patch: (model, ref, changes) => void patches.push({ model, ref, changes }),
    insert: () => undefined,
    find: () => [],
    archive: () => undefined,
    remove: () => undefined,
  };
  return { store, patches };
}

const predict = (store: OptimisticStore, input: object) =>
  userUpdateProfile.optimistic?.(store, userUpdateProfile.input.parse(input));

describe('user.updateProfile optimistic (AC-15)', () => {
  it('patches your own row with the given fields, as the server will write them', () => {
    const { store, patches } = fakeStore();
    predict(store, {
      name: ' Ada King ',
      displayName: 'ada.k ',
      timezone: 'europe/berlin',
      avatar: FILE.toUpperCase(),
    });
    expect(patches).toEqual([
      {
        model: 'User',
        ref: ME,
        changes: {
          name: 'Ada King',
          displayName: 'ada.k',
          avatarFileId: FILE,
          timezone: 'Europe/Berlin',
          updatedAt: NOW.toISOString(),
        },
      },
    ]);
  });

  it('removes the avatar with null and leaves out what isn’t given', () => {
    const { store, patches } = fakeStore();
    predict(store, { avatar: null });
    expect(patches[0]?.changes).toEqual({ avatarFileId: null, updatedAt: NOW.toISOString() });
  });

  it('predicts nothing before the signed-in user is known', () => {
    const { store, patches } = fakeStore(false);
    predict(store, { name: 'Ada' });
    expect(patches).toEqual([]);
  });
});
