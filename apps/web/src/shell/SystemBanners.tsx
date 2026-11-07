// Raises the SPEC-005 §8 banners from the sync store (system-banners.ts has the rules). Mounted
// inside `SyncStoreProvider` while the shell has a store; shows nothing itself.
import { useConnectionState, usePendingCount, useStorageWarning } from '@surface/sync-react';
import { banner } from '@surface/ui';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  CONNECTION_BANNER,
  STORAGE_BANNER,
  connectionBanner,
  nextBannerCheck,
  storageBanner,
} from './system-banners.js';

function subscribeOnline(changed: () => void): () => void {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/** `navigator.onLine`, live. A server render assumes online. */
function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export function SystemBanners() {
  const { reconnectingSince, liveUpdatesUnavailable } = useConnectionState();
  const pending = usePendingCount();
  const storageWarning = useStorageWarning();
  const browserOnline = useBrowserOnline();
  // Only "Reconnecting > 5 s" depends on the clock: a timer moves `now` when it is due.
  const [now, setNow] = useState(() => Date.now());

  const conditions = useMemo(
    () => ({
      reconnectingSince,
      liveUpdatesUnavailable,
      pending,
      browserOnline,
      storageWarning,
      now,
    }),
    [reconnectingSince, liveUpdatesUnavailable, pending, browserOnline, storageWarning, now],
  );
  const due = nextBannerCheck(conditions);
  useEffect(() => {
    if (due === undefined) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.max(0, due - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [due]);

  const connection = useMemo(() => connectionBanner(conditions), [conditions]);
  useEffect(() => {
    if (connection === null) banner.hide(CONNECTION_BANNER);
    else banner.show(CONNECTION_BANNER, connection);
  }, [connection]);

  // Its own effect: shown again only if the reason changes, so a dismissal sticks.
  useEffect(() => {
    const options = storageBanner({ storageWarning });
    if (options === null) banner.hide(STORAGE_BANNER);
    else banner.show(STORAGE_BANNER, options);
  }, [storageWarning]);

  useEffect(
    () => () => {
      banner.hide(CONNECTION_BANNER);
      banner.hide(STORAGE_BANNER);
    },
    [],
  );
  return null;
}
