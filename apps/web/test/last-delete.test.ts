// PLAN-012 S6 (SPEC-012 §3.11, AC-16, E23, E24; SPEC-015 E25): the last-delete memory and `Mod+Z`.
// The restore toast says "Restoring ENG-42…" until the mutation is confirmed, never waits for a
// packet (the fake store has no hub at all), and a refusal empties the memory.
import { overlayManager } from '@surface/ui';
import { afterEach, describe, expect, it } from 'vitest';
import { announcer } from '../src/features/issues/announcer.js';
import { deleteIssue, LastDelete, restoreLastDeleted } from '../src/features/issues/delete-flow.js';
import type { MutationStore } from '../src/features/teams/submit.js';

type Outcome =
  { status: 'confirmed' } | { status: 'rejected'; error: { code: string; message: string } };

/** A store whose answer to each dispatch the test gives when it likes. */
function fakeStore(connection = 'online') {
  const calls: { op: string; input: unknown; answer: (outcome: Outcome) => void }[] = [];
  const store: MutationStore = {
    connection,
    dispatch: (op, input) =>
      new Promise((resolve) => {
        calls.push({
          op: op.name,
          input,
          answer: (outcome) => {
            resolve(outcome);
          },
        });
      }),
  };
  return { store, calls };
}

const toasts = () => overlayManager.getSnapshot().visibleToasts.map((t) => t.message);
const rejected: Outcome = {
  status: 'rejected',
  error: { code: 'NOT_FOUND', message: 'ENG-42 was already deleted for good.' },
};

afterEach(() => {
  overlayManager.clear();
});

describe('LastDelete', () => {
  it('holds one issue: the next delete replaces it, a restore empties it', () => {
    const slot = new LastDelete();
    slot.set({ id: 'a', identifier: 'ENG-1' });
    slot.set({ id: 'b', identifier: 'ENG-2' });
    expect(slot.get()).toEqual({ id: 'b', identifier: 'ENG-2' });
    slot.clearIf('a');
    expect(slot.get()?.id).toBe('b');
    expect(slot.take()?.id).toBe('b');
    expect(slot.get()).toBeUndefined();
  });
});

describe('delete (§3.11)', () => {
  it('sends issue.delete, remembers the issue and announces it, with no Undo toast', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    const done = deleteIssue(store, { issueId: 'i1', identifier: 'ENG-42' }, slot);
    expect(calls.map((c) => [c.op, c.input])).toEqual([['issue.delete', { issue: 'i1' }]]);
    expect(slot.get()).toEqual({ id: 'i1', identifier: 'ENG-42' });
    expect(announcer.snapshot().text).toBe('ENG-42 deleted');
    calls[0]?.answer({ status: 'confirmed' });
    await done;
    expect(toasts()).toEqual([]);
    expect(slot.get()?.id).toBe('i1');
  });

  it('a rejected delete forgets the issue, so Mod+Z cannot restore what was never deleted (E25)', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    const done = deleteIssue(store, { issueId: 'i1', identifier: 'ENG-42' }, slot);
    calls[0]?.answer(rejected);
    await done;
    expect(slot.get()).toBeUndefined();
  });

  it('a rejection of an older delete keeps the newer one remembered', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    const first = deleteIssue(store, { issueId: 'i1', identifier: 'ENG-1' }, slot);
    const second = deleteIssue(store, { issueId: 'i2', identifier: 'ENG-2' }, slot);
    calls[0]?.answer(rejected);
    await first;
    expect(slot.get()?.id).toBe('i2');
    calls[1]?.answer({ status: 'confirmed' });
    await second;
  });
});

describe('Mod+Z (§3.11 item 3, AC-16)', () => {
  it('shows "Restoring ENG-42…" until the mutation is confirmed, then "Restored ENG-42"', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    slot.set({ id: 'i1', identifier: 'ENG-42' });
    const done = restoreLastDeleted(store, slot);
    expect(calls.map((c) => [c.op, c.input])).toEqual([['issue.restore', { issue: 'i1' }]]);
    expect(toasts()).toEqual(['Restoring ENG-42…']);
    // Nothing but the mutation's own answer finishes it: no packet is awaited.
    calls[0]?.answer({ status: 'confirmed' });
    await done;
    expect(toasts()).toEqual(['Restored ENG-42']);
    expect(announcer.snapshot().text).toBe('Restored ENG-42');
  });

  it('restores once: a second press does nothing, and the memory is empty after (E23)', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    slot.set({ id: 'i1', identifier: 'ENG-42' });
    const done = restoreLastDeleted(store, slot);
    await restoreLastDeleted(store, slot);
    expect(calls).toHaveLength(1);
    calls[0]?.answer({ status: 'confirmed' });
    await done;
    await restoreLastDeleted(store, slot);
    expect(calls).toHaveLength(1);
  });

  it('with nothing remembered it does nothing at all (E23)', async () => {
    const { store, calls } = fakeStore();
    await restoreLastDeleted(store, new LastDelete());
    expect(calls).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it('a refusal stops saying "Restoring", and the memory stays empty (E24)', async () => {
    const { store, calls } = fakeStore();
    const slot = new LastDelete();
    slot.set({ id: 'i1', identifier: 'ENG-42' });
    const done = restoreLastDeleted(store, slot);
    calls[0]?.answer(rejected);
    await done;
    expect(toasts()).not.toContain('Restoring ENG-42…');
    expect(slot.get()).toBeUndefined();
  });

  it('offline, the restore is queued and the toast says when it will finish', async () => {
    const { store } = fakeStore('offline');
    const slot = new LastDelete();
    slot.set({ id: 'i1', identifier: 'ENG-42' });
    await restoreLastDeleted(store, slot);
    expect(toasts()).toEqual(["ENG-42 will be restored when you're back online."]);
  });
});
