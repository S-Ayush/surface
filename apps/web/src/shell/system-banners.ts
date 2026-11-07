// The system banners of SPEC-005 §8 (PLAN-005 S7), from the sync store's state (PLAN-002 S10
// hooks; mapping agreed with session D). At most one connection banner shows: live updates
// unavailable, else offline, else reconnecting. The outdated-client banner is raised by the
// store's `onOutdated` (app/ShellRoute.tsx).
import type { BannerOptions } from '@surface/ui';

/** How long a reconnect may take before it is announced (SPEC-005 §8: "Reconnecting > 5 s"). */
export const RECONNECTING_AFTER_MS = 5000;

export const CONNECTION_BANNER = 'sync-connection';
export const STORAGE_BANNER = 'sync-storage';

export type SyncConditions = {
  /** Epoch ms the connection has been trying to come back since; undefined while online. */
  readonly reconnectingSince: number | undefined;
  /** The server answers HTTP but WebSocket upgrades keep failing (sync-protocol.md §4.3). */
  readonly liveUpdatesUnavailable: boolean;
  /** Changes not yet confirmed by the server. */
  readonly pending: number;
  /** `navigator.onLine`. */
  readonly browserOnline: boolean;
  /** Why the replica isn't kept in IndexedDB, if it isn't. */
  readonly storageWarning: string | undefined;
  /** Epoch ms. */
  readonly now: number;
};

export function connectionBanner(c: SyncConditions): BannerOptions | null {
  if (c.liveUpdatesUnavailable) {
    return {
      tone: 'danger',
      message: 'Live updates unavailable: check your proxy’s WebSocket settings.',
    };
  }
  if (c.reconnectingSince === undefined) return null;
  if (!c.browserOnline) {
    const pending = c.pending > 0 ? ` · ${String(c.pending)} pending` : '';
    return {
      tone: 'warning',
      message: `Offline: changes will sync when you reconnect${pending}`,
      dismissible: false,
    };
  }
  if (c.now - c.reconnectingSince > RECONNECTING_AFTER_MS) {
    return { tone: 'info', message: 'Reconnecting…' };
  }
  return null;
}

export function storageBanner(c: Pick<SyncConditions, 'storageWarning'>): BannerOptions | null {
  return c.storageWarning === undefined
    ? null
    : {
        tone: 'warning',
        message: 'Offline mode unavailable in this browser session',
        dismissible: true,
      };
}

/**
 * When the connection banner may next change with time alone: the moment "Reconnecting…" is due,
 * or undefined if nothing waits on the clock.
 */
export function nextBannerCheck(c: SyncConditions): number | undefined {
  if (c.reconnectingSince === undefined || c.liveUpdatesUnavailable || !c.browserOnline) {
    return undefined;
  }
  const due = c.reconnectingSince + RECONNECTING_AFTER_MS + 1;
  return due > c.now ? due : undefined;
}
