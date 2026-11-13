/**
 * React hooks over the sync store for PLAN-005 (SPEC-002 §7, SPEC-005 §8).
 * Each wraps a `sync-client` selector with `observe` and React's
 * `useSyncExternalStore` (ADR-0017), so a component re-renders only when the
 * selected value changes. The rejection toast and the reload banner are store
 * options (`onRejected`, `onOutdated`), not hooks.
 */
import type {
  BootstrapSnapshot,
  ConnectionSnapshot,
  InspectorSnapshot,
  SyncStore,
  TeamLoadState,
} from '@surface/sync-client';
import {
  bootstrapOf,
  connectionOf,
  inspect,
  observe,
  pendingCountOf,
  storageWarningOf,
} from '@surface/sync-client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSyncStore } from './context.js';

/** `select` must be a stable function (module level), or the source is rebuilt each render. */
function useSelected<T>(select: (store: SyncStore) => T): T {
  const store = useSyncStore();
  const source = useMemo(() => observe(() => select(store)), [store, select]);
  // The server snapshot is the same: the store exists only in the browser, so
  // a server render (and the Node tests) reads its initial state.
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/**
 * The live connection: `state`, how long it has been trying to get back
 * online (`reconnectingSince`, epoch ms, for "Reconnecting > 5 s"), and
 * whether live updates look blocked (`liveUpdatesUnavailable`, SPEC-005 §8).
 */
export function useConnectionState(): ConnectionSnapshot {
  return useSelected(connectionOf);
}

/** Changes not yet confirmed by the server ("Offline · N pending"). */
export function usePendingCount(): number {
  return useSelected(pendingCountOf);
}

/** The start-up: status, rows received of the total, and why it failed. */
export function useBootstrapProgress(): BootstrapSnapshot {
  return useSelected(bootstrapOf);
}

/** Why the replica isn't saved offline (the IndexedDB banner), or `undefined`. */
export function useStorageWarning(): string | undefined {
  return useSelected(storageWarningOf);
}

/** Everything the inspector shows. */
export function useInspector(): InspectorSnapshot {
  return useSelected(inspect);
}

/**
 * Whether a team's issues can be shown (SPEC-011 §5.7, AC-27, E34), opening the team while the
 * component is mounted: a public team the user isn't a member of is subscribed on demand and
 * loaded with the partial bootstrap (`loading` until then). `ready` for a team the replica
 * holds or has nothing to load for; `offline` when it was never loaded and can't be now
 * ("Available when online").
 */
export function useTeamLoadState(teamId: string): TeamLoadState {
  const store = useSyncStore();
  // Opening it again (another list, a remount) makes it the most recently opened (E31).
  useEffect(() => {
    if (teamId !== '') store.openTeam(teamId);
  }, [store, teamId]);
  const source = useMemo(
    () => observe(() => (teamId === '' ? 'loading' : store.teamLoadState(teamId))),
    [store, teamId],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
