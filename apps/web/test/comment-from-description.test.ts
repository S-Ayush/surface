// SPEC-012 §3.6 (PLAN-012 S7b): "Comment" from the description saves it first, then focuses the
// comment box.
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import type { DescriptionSaver } from '../src/features/issues/description-save.js';
import { commentFromDescription, saversOf } from '../src/features/issues/description-savers.js';

// Only what the helper calls: it never reads the store, which just keys the savers.
const storeStub = (): SyncStore => ({}) as unknown as SyncStore;
const saverStub = (calls: string[]): DescriptionSaver =>
  ({
    saveNow: () => {
      calls.push('save');
    },
  }) as unknown as DescriptionSaver;

describe('Comment from the description', () => {
  it('saves the description, then focuses the comment box', () => {
    const calls: string[] = [];
    const store = storeStub();
    saversOf(store).set('i-1', saverStub(calls));
    commentFromDescription(store, 'i-1', () => calls.push('focus'));
    expect(calls).toEqual(['save', 'focus']);
  });

  it('only focuses when the issue has no saver', () => {
    const calls: string[] = [];
    commentFromDescription(storeStub(), 'i-1', () => calls.push('focus'));
    expect(calls).toEqual(['focus']);
  });
});
