/**
 * Selectors over the store for the UI hooks (PLAN-005) and the sync inspector
 * (SPEC-002 §5.4). Each returns plain data, so `observe(() => select(store))`
 * gives a framework a stable snapshot (ADR-0017).
 */
import type { BootstrapProgress } from './bootstrap.js';
import type { PendingView, Rejection } from './queue.js';
import type { ConnectionState } from './socket.js';
import type { PacketView, RoundTrip, SyncStatus, SyncStore } from './store.js';

/** The live connection, for the offline and reconnecting banners (SPEC-005 §8). */
export interface ConnectionSnapshot {
  readonly state: ConnectionState;
  /** Epoch ms when `state` last changed, for the inspector. */
  readonly since: number;
  /**
   * Epoch ms since the connection has been trying to get back online, across
   * retries; `undefined` while online or stopped. "Reconnecting > 5 s"
   * compares against it.
   */
  readonly reconnectingSince: number | undefined;
  /** The server answers HTTP, but WebSocket attempts keep failing: a proxy may block them. */
  readonly liveUpdatesUnavailable: boolean;
}

export function connectionOf(store: SyncStore): ConnectionSnapshot {
  return {
    state: store.connection,
    since: store.connectionSince,
    reconnectingSince: store.reconnectingSince,
    liveUpdatesUnavailable: store.liveUpdatesUnavailable,
  };
}

/** Changes not yet confirmed by the server ("Offline · N pending", SPEC-002 §7). */
export function pendingCountOf(store: SyncStore): number {
  return store.pending.length;
}

/** The start-up, for the progress bar and its failure screen (SPEC-002 §7, E13). */
export interface BootstrapSnapshot {
  readonly status: SyncStatus;
  /** Rows received of the total, while a cold start or resync streams them. */
  readonly progress: BootstrapProgress | undefined;
  /** Why the last start or resync failed. */
  readonly error: string | undefined;
}

export function bootstrapOf(store: SyncStore): BootstrapSnapshot {
  return { status: store.status, progress: store.progress, error: store.error };
}

/** Why the replica isn't saved offline, for the IndexedDB banner (SPEC-005 §8). */
export function storageWarningOf(store: SyncStore): string | undefined {
  return store.storageWarning;
}

/** Everything the sync inspector shows (SPEC-002 §5.4), except the IDB size. */
export interface InspectorSnapshot {
  readonly status: SyncStatus;
  readonly error: string | undefined;
  readonly connection: ConnectionSnapshot;
  readonly clientId: string;
  readonly lastSyncId: number | undefined;
  readonly persistent: boolean;
  readonly storageWarning: string | undefined;
  /** In seq order. */
  readonly pending: readonly PendingView[];
  readonly roundTrip: RoundTrip | undefined;
  /** Newest first. */
  readonly packets: readonly PacketView[];
  /** Newest last. */
  readonly rejections: readonly Rejection[];
  /**
   * Rows per model as the app sees them: the replica with pending changes on
   * top (a pending create counts, a pending delete does not), archived ones included.
   */
  readonly rows: readonly { readonly model: string; readonly count: number }[];
}

export function inspect(store: SyncStore): InspectorSnapshot {
  return {
    status: store.status,
    error: store.error,
    connection: connectionOf(store),
    clientId: store.clientId,
    lastSyncId: store.position?.lastSyncId,
    persistent: store.persistent,
    storageWarning: store.storageWarning,
    pending: [...store.pending],
    roundTrip: store.lastRoundTrip,
    packets: [...store.recentPackets],
    rejections: [...store.rejections],
    rows: store.modelNames.map((model) => ({ model, count: store.pool.count(model) })),
  };
}

/** `navigator.storage.estimate`, or another source of the same shape. */
export type StorageEstimator = () => Promise<{ readonly usage?: number | undefined }>;

/**
 * Bytes the origin stores (IndexedDB included), for the inspector's IDB size;
 * `undefined` where the browser does not say.
 */
export async function storageUsage(
  estimate: StorageEstimator | undefined = browserEstimator(),
): Promise<number | undefined> {
  if (estimate === undefined) return undefined;
  try {
    return (await estimate()).usage;
  } catch {
    return undefined;
  }
}

function browserEstimator(): StorageEstimator | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const storage: StorageManager | undefined = navigator.storage;
  if (storage === undefined || typeof storage.estimate !== 'function') return undefined;
  return () => storage.estimate();
}
