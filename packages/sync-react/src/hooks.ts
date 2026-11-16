/**
 * React hooks over the sync store for PLAN-005 (SPEC-002 §7, SPEC-005 §8).
 * Each wraps a `sync-client` selector with `observe` and React's
 * `useSyncExternalStore` (ADR-0017), so a component re-renders only when the
 * selected value changes. The rejection toast and the reload banner are store
 * options (`onRejected`, `onOutdated`), not hooks.
 */
import type { ModelRow } from '@surface/domain/model';
import type {
  BootstrapSnapshot,
  ConnectionSnapshot,
  ContentLoadState,
  InspectorSnapshot,
  SyncStore,
  TeamLoadState,
} from '@surface/sync-client';
import {
  PREFETCH_LIST_ROWS,
  bootstrapOf,
  connectionOf,
  inspect,
  observe,
  pendingCountOf,
  storageWarningOf,
} from '@surface/sync-client';
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
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

/** An issue's content as `useIssueContent` shows it. */
export interface IssueContent {
  /** `loading` until paged in; `offline` when never loaded and the connection is down (E11). */
  readonly state: ContentLoadState;
  /** The issue's content rows in memory, per content model (`Comment`, `IssueContent`…), by id. */
  readonly rows: Readonly<Record<string, readonly ModelRow[]>>;
}

/**
 * An issue's content (SPEC-011 §5.3, §5.4; PLAN-011 S5b), opened while the component is mounted:
 * paged in from the replica, or fetched, and kept live until it unmounts. Opening it subscribes
 * the issue's team if needed (§5.7). `offline` means "Available when online" (E11).
 */
export function useIssueContent(issueId: string): IssueContent {
  const store = useSyncStore();
  useEffect(() => {
    if (issueId === '') return undefined;
    const handle = store.content.open(issueId);
    return () => handle.release();
  }, [store, issueId]);
  const source = useMemo(
    () =>
      observe((): IssueContent =>
        issueId === ''
          ? { state: 'loading', rows: {} }
          : { state: store.content.state(issueId), rows: store.content.rows(issueId) },
      ),
    [store, issueId],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/**
 * Prefetch the content of the issues a view shows, in order (SPEC-011 §5.4; PLAN-011 S7): the
 * first `limit` (50) once they have stayed for 200 ms, so scrolling past rows fetches nothing.
 * Only issues of subscribed teams that aren't hydrated yet are fetched. Unmounting cancels a
 * pending prefetch.
 */
export function usePrefetchContent(
  issueIds: readonly string[],
  limit: number = PREFETCH_LIST_ROWS,
): void {
  const store = useSyncStore();
  const slot = useId();
  // A key, so a new array with the same ids doesn't restart the wait.
  const key = issueIds.slice(0, limit).join(',');
  useEffect(() => {
    store.content.prefetchList(slot, key === '' ? [] : key.split(','), limit);
  }, [store, slot, key, limit]);
  useEffect(() => () => store.content.prefetchList(slot, []), [store, slot]);
}

/** Pointer handlers for `usePrefetchOnHover`. */
export interface HoverPrefetch {
  /** The pointer entered an issue's row or link. */
  readonly enter: (issueId: string) => void;
  /** It left (or the row unmounted). Bound: pass it as an event handler. */
  readonly leave: () => void;
}

/**
 * Prefetch an issue's content when the pointer rests on it for 150 ms (SPEC-011 §5.4). One
 * pending issue at a time: entering another cancels the previous one.
 */
export function usePrefetchOnHover(): HoverPrefetch {
  const store = useSyncStore();
  const cancel = useRef<(() => void) | undefined>(undefined);
  const handlers = useMemo(
    (): HoverPrefetch => ({
      enter: (issueId) => {
        cancel.current?.();
        cancel.current = store.content.prefetchOnHover(issueId);
      },
      leave: () => {
        cancel.current?.();
        cancel.current = undefined;
      },
    }),
    [store],
  );
  useEffect(() => () => handlers.leave(), [handlers]);
  return handlers;
}
