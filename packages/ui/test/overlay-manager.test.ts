// The overlay manager's stack and queues (PLAN-005 S3). Focus, Esc and rendering are covered by the
// Storybook tests of Dialog, Menu, Popover, Toast and Banner (`pnpm test:storybook`).
import { describe, expect, it, vi } from 'vitest';
import {
  BANNER_PRIORITY,
  MAX_VISIBLE_TOASTS,
  OverlayManager,
  TOAST_ACTION_DURATION_MS,
  TOAST_DURATION_MS,
} from '../src/overlays/manager.js';

const ids = (toasts: readonly { id: string }[]) => toasts.map((t) => t.id);

describe('layer stack', () => {
  it('reports the most recently opened layer as the top', () => {
    const manager = new OverlayManager();
    expect(manager.topLayer()).toBeUndefined();
    const dialog = manager.pushLayer('modal');
    const menu = manager.pushLayer('menu');
    expect(manager.topLayer()).toEqual({ id: menu, kind: 'menu' });
    manager.removeLayer(menu);
    expect(manager.topLayer()).toEqual({ id: dialog, kind: 'modal' });
    manager.removeLayer(dialog);
    expect(manager.topLayer()).toBeUndefined();
  });

  it('removes a layer from the middle of the stack, keeping the order of the rest', () => {
    const manager = new OverlayManager();
    const a = manager.pushLayer('modal');
    const b = manager.pushLayer('modal');
    const c = manager.pushLayer('popover');
    manager.removeLayer(b);
    expect(manager.getSnapshot().layers.map((l) => l.id)).toEqual([a, c]);
  });

  it('ignores removing a layer twice, without notifying', () => {
    const manager = new OverlayManager();
    const id = manager.pushLayer('modal');
    manager.removeLayer(id);
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.removeLayer(id);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('toasts', () => {
  it('lasts 5 s, or 8 s with an action, unless a duration is given', () => {
    const manager = new OverlayManager();
    manager.toast('Saved');
    manager.toast({ message: 'Issue deleted', action: { label: 'Undo', onAction: () => {} } });
    manager.toast({ message: 'Pinned', duration: Infinity });
    expect(manager.getSnapshot().visibleToasts.map((t) => t.duration)).toEqual([
      TOAST_DURATION_MS,
      TOAST_ACTION_DURATION_MS,
      Infinity,
    ]);
    expect([TOAST_DURATION_MS, TOAST_ACTION_DURATION_MS]).toEqual([5000, 8000]);
  });

  it('shows at most three and queues the rest, oldest first', () => {
    const manager = new OverlayManager();
    const all = ['1', '2', '3', '4', '5'].map((n) => manager.toast({ message: n, id: n }));
    const snapshot = manager.getSnapshot();
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(ids(snapshot.visibleToasts)).toEqual(all.slice(0, 3));
    expect(ids(snapshot.queuedToasts)).toEqual(all.slice(3));
  });

  it('moves the oldest queued toast up when a visible one is dismissed', () => {
    const manager = new OverlayManager();
    for (const n of ['1', '2', '3', '4', '5']) manager.toast({ message: n, id: n });
    manager.dismissToast('2');
    expect(ids(manager.getSnapshot().visibleToasts)).toEqual(['1', '3', '4']);
    expect(ids(manager.getSnapshot().queuedToasts)).toEqual(['5']);
  });

  it('replaces a toast with the same id in place instead of stacking a duplicate', () => {
    const manager = new OverlayManager();
    manager.toast({ message: 'Syncing 3 changes', id: 'sync' });
    manager.toast('Other');
    manager.toast({ message: 'Syncing 1 change', id: 'sync', tone: 'success' });
    const visible = manager.getSnapshot().visibleToasts;
    expect(ids(visible)).toEqual(['sync', expect.stringMatching(/^toast-/)]);
    expect(visible[0]).toMatchObject({ message: 'Syncing 1 change', tone: 'success' });
  });

  it('holds a new toast while an overlay is open, so Esc keeps reaching the overlay', () => {
    const manager = new OverlayManager();
    manager.toast({ message: 'Before', id: 'before' });
    const dialog = manager.pushLayer('modal');
    manager.toast({ message: 'During', id: 'during' });
    expect(ids(manager.getSnapshot().visibleToasts)).toEqual(['before']);
    expect(ids(manager.getSnapshot().queuedToasts)).toEqual(['during']);
    manager.removeLayer(dialog);
    expect(ids(manager.getSnapshot().visibleToasts)).toEqual(['before', 'during']);
  });

  it('keeps an updated toast on screen while an overlay is open', () => {
    const manager = new OverlayManager();
    manager.toast({ message: 'Syncing 3 changes', id: 'sync' });
    manager.pushLayer('menu');
    manager.toast({ message: 'Syncing 1 change', id: 'sync' });
    expect(manager.getSnapshot().visibleToasts.map((t) => t.message)).toEqual(['Syncing 1 change']);
  });

  it('defaults to a neutral tone and gives every toast a distinct id', () => {
    const manager = new OverlayManager();
    const a = manager.toast('One');
    const b = manager.toast('Two');
    expect(a).not.toBe(b);
    expect(manager.getSnapshot().visibleToasts.every((t) => t.tone === 'neutral')).toBe(true);
  });
});

describe('banners', () => {
  it('shows the most severe banner, then the oldest of equal severity', () => {
    const manager = new OverlayManager();
    manager.showBanner('outdated', { message: 'Surface was updated.', tone: 'info' });
    manager.showBanner('idb', { message: 'Offline mode unavailable', tone: 'warning' });
    manager.showBanner('offline', { message: 'Offline', tone: 'warning' });
    expect(manager.getSnapshot().banner?.id).toBe('idb');
    manager.showBanner('ws', { message: 'Live updates unavailable', tone: 'danger' });
    expect(manager.getSnapshot().banners.map((b) => b.id)).toEqual([
      'ws',
      'idb',
      'offline',
      'outdated',
    ]);
    manager.hideBanner('ws');
    manager.hideBanner('idb');
    expect(manager.getSnapshot().banner?.id).toBe('offline');
  });

  it('updates a banner in place when shown again with the same id', () => {
    const manager = new OverlayManager();
    manager.showBanner('offline', { message: 'Offline · 3 pending', tone: 'warning' });
    manager.showBanner('offline', { message: 'Offline · 4 pending', tone: 'warning' });
    expect(manager.getSnapshot().banners).toHaveLength(1);
    expect(manager.getSnapshot().banner?.message).toBe('Offline · 4 pending');
  });

  it('lets an explicit priority outrank a more severe tone', () => {
    const manager = new OverlayManager();
    manager.showBanner('idb', {
      message: 'Offline mode unavailable',
      tone: 'warning',
      dismissible: true,
    });
    manager.showBanner('outdated', {
      message: 'Surface was updated.',
      tone: 'info',
      priority: BANNER_PRIORITY.blocking,
    });
    expect(manager.getSnapshot().banner?.id).toBe('outdated');
  });

  it('is persistent unless marked dismissible', () => {
    const manager = new OverlayManager();
    manager.showBanner('a', { message: 'A', tone: 'info' });
    manager.showBanner('b', { message: 'B', tone: 'warning', dismissible: true });
    const byId = new Map(manager.getSnapshot().banners.map((b) => [b.id, b.dismissible]));
    expect(byId).toEqual(
      new Map([
        ['a', false],
        ['b', true],
      ]),
    );
  });
});

describe('toast ids and updates', () => {
  it('never generates an id a caller already chose', () => {
    const manager = new OverlayManager();
    manager.toast({ message: 'Mine', id: 'toast-1' });
    manager.toast({ message: 'Mine too', id: 'toast-2' });
    const generated = manager.toast('Generated');
    expect(['toast-1', 'toast-2']).not.toContain(generated);
    expect(manager.getSnapshot().visibleToasts).toHaveLength(3);
  });

  it('gives an updated toast a new revision, so it is announced again and its timer restarts', () => {
    const manager = new OverlayManager();
    manager.toast({ message: 'Syncing 3 changes', id: 'sync' });
    const before = manager.getSnapshot().visibleToasts[0]?.revision;
    manager.toast({ message: 'Syncing 1 change', id: 'sync' });
    expect(manager.getSnapshot().visibleToasts[0]?.revision).not.toBe(before);
  });
});

describe('Esc ownership', () => {
  it("marks an Esc pressed while an overlay is open as the overlay's, and only that one", () => {
    const manager = new OverlayManager();
    const onPage = { key: 'Escape' };
    manager.noteKeydown(onPage);
    const layer = manager.pushLayer('modal');
    const inDialog = { key: 'Escape' };
    const otherKey = { key: 'k' };
    manager.noteKeydown(inDialog);
    manager.noteKeydown(otherKey);
    // The dialog closes on it before the page's listener runs; the answer must not change.
    manager.removeLayer(layer);
    expect(manager.isOverlayEscape(inDialog)).toBe(true);
    expect(manager.isOverlayEscape(onPage)).toBe(false);
    expect(manager.isOverlayEscape(otherKey)).toBe(false);
  });
});

describe('subscriptions', () => {
  it('notifies on every change and hands out a new snapshot each time', () => {
    const manager = new OverlayManager();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    const before = manager.getSnapshot();
    manager.toast('Saved');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).not.toBe(before);
    unsubscribe();
    manager.toast('Again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns the same snapshot while nothing changes (useSyncExternalStore requirement)', () => {
    const manager = new OverlayManager();
    manager.toast('Saved');
    expect(manager.getSnapshot()).toBe(manager.getSnapshot());
  });

  it('clears toasts and banners but keeps open layers', () => {
    const manager = new OverlayManager();
    const layer = manager.pushLayer('modal');
    manager.toast('Saved');
    manager.showBanner('offline', { message: 'Offline', tone: 'warning' });
    manager.clear();
    const snapshot = manager.getSnapshot();
    expect(snapshot.visibleToasts).toEqual([]);
    expect(snapshot.banner).toBeUndefined();
    expect(snapshot.layers.map((l) => l.id)).toEqual([layer]);
  });
});
