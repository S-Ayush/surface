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
} from '@surface/sync-client';
import {
  bootstrapOf,
  connectionOf,
  inspect,
  observe,
  pendingCountOf,
  storageWarningOf,
} from '@surface/sync-client';
import { useMemo, useSyncExternalStore } from 'react';
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
