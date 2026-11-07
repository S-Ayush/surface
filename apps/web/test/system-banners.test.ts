// SPEC-005 §8 (AC-14, unit part): which system banner the sync store's state raises. At most one
// connection banner, in session D's order: live updates unavailable, offline, reconnecting > 5 s.
// AC-14 under simulated conditions is e2e (held).
import { describe, expect, it } from 'vitest';
import {
  RECONNECTING_AFTER_MS,
  connectionBanner,
  nextBannerCheck,
  storageBanner,
  type SyncConditions,
} from '../src/shell/system-banners.js';

const NOW = 1_800_000_000_000;

const conditions = (changes: Partial<SyncConditions> = {}): SyncConditions => ({
  reconnectingSince: undefined,
  liveUpdatesUnavailable: false,
  pending: 0,
  browserOnline: true,
  storageWarning: undefined,
  now: NOW,
  ...changes,
});

describe('connection banner', () => {
  it('shows nothing while connected', () => {
    expect(connectionBanner(conditions())).toBeNull();
  });

  it('says the browser is offline at once, with the changes waiting (persistent)', () => {
    const offline = conditions({ reconnectingSince: NOW - 100, browserOnline: false, pending: 3 });
    expect(connectionBanner(offline)).toEqual({
      tone: 'warning',
      message: 'Offline: changes will sync when you reconnect · 3 pending',
      dismissible: false,
    });
    expect(connectionBanner({ ...offline, pending: 0 })?.message).toBe(
      'Offline: changes will sync when you reconnect',
    );
  });

  it('says it is reconnecting only after 5 s', () => {
    const since = NOW - RECONNECTING_AFTER_MS;
    expect(connectionBanner(conditions({ reconnectingSince: since }))).toBeNull();
    expect(connectionBanner(conditions({ reconnectingSince: since - 1 }))).toEqual({
      tone: 'info',
      message: 'Reconnecting…',
    });
  });

  it('puts live updates unavailable above the others', () => {
    const blocked = conditions({
      liveUpdatesUnavailable: true,
      reconnectingSince: NOW - 60_000,
      browserOnline: false,
    });
    expect(connectionBanner(blocked)).toEqual({
      tone: 'danger',
      message: 'Live updates unavailable: check your proxy’s WebSocket settings.',
    });
  });

  it('puts offline above reconnecting', () => {
    const both = conditions({ reconnectingSince: NOW - 60_000, browserOnline: false });
    expect(connectionBanner(both)?.message).toMatch(/^Offline/);
  });
});

describe('when to look at the clock again', () => {
  it('is just after the 5 s mark while reconnecting with the browser online', () => {
    const since = NOW - 1000;
    expect(nextBannerCheck(conditions({ reconnectingSince: since }))).toBe(
      since + RECONNECTING_AFTER_MS + 1,
    );
  });

  it('is never when nothing waits on time', () => {
    expect(nextBannerCheck(conditions())).toBeUndefined();
    expect(nextBannerCheck(conditions({ reconnectingSince: NOW - 10_000 }))).toBeUndefined();
    expect(
      nextBannerCheck(conditions({ reconnectingSince: NOW, browserOnline: false })),
    ).toBeUndefined();
    expect(
      nextBannerCheck(conditions({ reconnectingSince: NOW, liveUpdatesUnavailable: true })),
    ).toBeUndefined();
  });

  it('shows the banner once the moment it names has come', () => {
    const start = conditions({ reconnectingSince: NOW });
    const due = nextBannerCheck(start);
    expect(due).toBeDefined();
    expect(connectionBanner({ ...start, now: due ?? 0 })?.message).toBe('Reconnecting…');
  });
});

describe('IndexedDB banner', () => {
  it('shows a dismissible warning when the replica can’t be kept offline', () => {
    expect(storageBanner({ storageWarning: 'IndexedDB is blocked' })).toEqual({
      tone: 'warning',
      message: 'Offline mode unavailable in this browser session',
      dismissible: true,
    });
    expect(storageBanner({ storageWarning: undefined })).toBeNull();
  });
});
