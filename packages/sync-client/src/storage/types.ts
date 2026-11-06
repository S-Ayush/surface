/**
 * Local persistence of the replica (SPEC-002 §3.1–3.2, PLAN-002 S6): base
 * rows per model, `meta`, and the pending-mutation queue. Implemented over
 * IndexedDB (run in a worker) and in memory (fallback, SPEC-002 E6).
 *
 * Several tabs of one user share the database (E5), each applying the same
 * delta stream at its own pace. Three rules keep a slower tab from corrupting
 * what a faster one wrote:
 * - **Generation fence:** each bootstrap starts a new generation. Writes name
 *   the generation they belong to and fail with `StorageFencedError` once
 *   another tab has re-bootstrapped. That tab then stops persisting.
 * - **Row versions:** a stored row records the sync id that last wrote it. A
 *   delta older than the stored version is skipped.
 * - **Tombstones:** a deleted row keeps its version, so an older upsert cannot
 *   bring it back. `meta.lastSyncId` only moves forward.
 */
import type { ModelRow } from '@surface/domain/model';
import type { SyncGroup } from '@surface/sync-protocol';

export interface StoredMeta {
  readonly schemaHash: string;
  /** Changes on every bootstrap; see the generation fence above. */
  readonly generation: string;
  /** Every delta up to this id is stored. */
  readonly lastSyncId: number;
  readonly groups: readonly SyncGroup[];
  /** `bootstrapping` until the `end` frame is stored; a warm start ignores anything else. */
  readonly state: 'bootstrapping' | 'ready';
}

/** A row as stored. `row: null` is a tombstone. */
export interface StoredRecord {
  readonly id: string;
  /** The sync id of the packet (or bootstrap snapshot) that last wrote this row. */
  readonly version: number;
  readonly archived: boolean;
  readonly row: ModelRow | null;
}

/** A live row read back for a warm start. */
export interface HydratedRow {
  readonly row: ModelRow;
  readonly archived: boolean;
}

export interface RowPage {
  readonly rows: HydratedRow[];
  /** Pass to the next `readRows` call; `undefined` when there are no more rows. */
  readonly next: string | undefined;
}

/** One base change from a delta packet, tagged with the packet's sync id. */
export type StoredChange =
  | {
      readonly kind: 'upsert';
      readonly model: string;
      readonly version: number;
      readonly row: ModelRow;
    }
  | {
      readonly kind: 'archive' | 'unarchive' | 'delete';
      readonly model: string;
      readonly version: number;
      readonly id: string;
    };

/** A row from the bootstrap stream. */
export interface BootstrapRecord {
  readonly model: string;
  readonly row: ModelRow;
  readonly archived: boolean;
}

export interface BootstrapStart {
  readonly schemaHash: string;
  readonly lastSyncId: number;
  readonly groups: readonly SyncGroup[];
}

/**
 * One mutation queue (PLAN-002 S8): a `clientId` and its seq counter. Each tab
 * owns one queue at a time (SPEC-002 E5). A tab that closes or reloads leaves
 * its queue behind, and the next tab to start adopts it, so the same
 * `(clientId, seq)` pairs are resent and the server dedupes them.
 */
export interface StoredClient {
  readonly clientId: string;
  /** The seq the next dispatched mutation gets. */
  readonly nextSeq: number;
  /** A per-tab token. Writes name it and fail with `QueueFencedError` once another tab took over. */
  readonly owner: string;
  /** Epoch ms. Without Web Locks, a queue whose lease ran out may be adopted; 0 = released. */
  readonly leaseUntil: number;
}

/** A mutation waiting for the server (sync-protocol.md §5.1). */
export interface PendingRecord {
  readonly clientId: string;
  readonly seq: number;
  readonly op: string;
  /** The input as dispatched (JSON); it is parsed again for `optimistic()` and by the server. */
  readonly input: unknown;
  /** Dispatch time (ISO). `optimistic()` sees it as `now`, so a replay is deterministic. */
  readonly at: string;
  /** Set once the server committed it: confirmed when the replica reaches this id. */
  readonly lastSyncId?: number;
}

export interface QueueSnapshot {
  readonly clients: readonly StoredClient[];
  /** Ordered by clientId, then seq. */
  readonly pending: readonly PendingRecord[];
}

/** Changes to one queue, made atomically by the tab that owns it. */
export interface QueueWrite {
  readonly clientId: string;
  /** The writer's token; must still own the queue. */
  readonly owner: string;
  readonly nextSeq?: number;
  readonly leaseUntil?: number;
  readonly put?: readonly PendingRecord[];
  readonly remove?: readonly number[];
}

/**
 * Take a queue for `owner`. With `clientId`, that queue (created if missing):
 * the caller holds its Web Lock. Without (lease mode), a queue with pending
 * mutations whose lease ended before `now`, else a new one with id `fresh`,
 * else (no `fresh`) nothing. An expired queue with nothing pending is left
 * alone: its tab may only be frozen, and adopting it would gain nothing but
 * fence that tab. Empty queues that were released (lease 0) or whose lease
 * ended over a day ago are forgotten.
 */
export interface QueueClaim {
  readonly owner: string;
  readonly now: number;
  readonly leaseUntil: number;
  readonly clientId?: string;
  readonly fresh?: string;
}

/** An empty queue whose lease ended this long ago is forgotten (lease mode). */
export const FORGET_EMPTY_QUEUE_MS = 86_400_000;

/** A claimed queue and its pending mutations, in seq order. */
export interface ClaimedQueue {
  readonly client: StoredClient;
  readonly pending: readonly PendingRecord[];
}

/** Members are function properties: the worker RPC calls them detached from the object. */
export interface SyncStorage {
  /** `indexeddb` persists across reloads; `memory` does not (E6). */
  readonly kind: 'indexeddb' | 'memory';

  readonly readMeta: () => Promise<StoredMeta | undefined>;

  /** Remove every row and the meta, and start a new generation. Pending mutations are kept (E8). */
  readonly beginBootstrap: (start: BootstrapStart) => Promise<string>;

  /** Store bootstrap rows (version = the snapshot's `lastSyncId`). */
  readonly writeBootstrapRows: (
    generation: string,
    rows: readonly BootstrapRecord[],
  ) => Promise<void>;

  /** Mark the generation `ready`, so a later start can hydrate from it. */
  readonly finishBootstrap: (generation: string) => Promise<void>;

  /** Page through a model's live rows in id order, for a warm start. */
  readonly readRows: (model: string, after: string | undefined, limit: number) => Promise<RowPage>;

  /**
   * Store delta changes and advance `lastSyncId` in one transaction (PLAN-002 S7),
   * so a crash never leaves `lastSyncId` ahead of the rows.
   */
  readonly applyChanges: (
    generation: string,
    changes: readonly StoredChange[],
    lastSyncId: number,
  ) => Promise<void>;

  /** Every queue and pending mutation, for a start or for adopting a queue. */
  readonly readQueue: () => Promise<QueueSnapshot>;

  /**
   * See `QueueClaim`. The claim, the owner change and reading the queue's
   * pending mutations are one transaction, so nothing the old owner wrote is missed.
   */
  readonly claimQueue: (claim: QueueClaim) => Promise<ClaimedQueue | undefined>;

  /** Apply `write` in one transaction; `QueueFencedError` if another tab owns the queue now. */
  readonly writeQueue: (write: QueueWrite) => Promise<void>;

  /** Drop all rows and the meta (resync); keeps pending mutations. */
  readonly clear: () => Promise<void>;

  readonly close: () => Promise<void>;
}

/** Another tab re-bootstrapped the shared database; this tab must stop writing to it. */
export class StorageFencedError extends Error {
  override readonly name = 'StorageFencedError';
  constructor() {
    // Handled by `Persistence`, never shown: the other tab keeps the replica saved.
    super('Another tab replaced the local replica.');
  }
}

/** Another tab adopted this tab's mutation queue (its lease ran out); this tab must stop using it. */
export class QueueFencedError extends Error {
  override readonly name = 'QueueFencedError';
  constructor() {
    super('Another tab took over the changes waiting to be sent. Reload this tab.');
  }
}

/** The queue a claim picks from `clients`; `undefined` means create `claim.fresh`. */
/**
 * What a claim does (`QueueClaim`): the queue to write (`undefined`: none),
 * and the ids of empty queues to forget. Shared by the storage backends.
 */
export function planClaim(
  clients: readonly StoredClient[],
  claim: QueueClaim,
  hasPending: (clientId: string) => boolean,
): { readonly client: StoredClient | undefined; readonly forget: readonly string[] } {
  if (claim.clientId !== undefined) {
    const picked = clients.find((c) => c.clientId === claim.clientId);
    return { client: claimed(picked, claim.clientId, claim), forget: [] };
  }
  const forget = clients
    .filter(
      (c) =>
        !hasPending(c.clientId) &&
        (c.leaseUntil === 0 || c.leaseUntil < claim.now - FORGET_EMPTY_QUEUE_MS),
    )
    .map((c) => c.clientId);
  // By id, so tabs agree on the order.
  const picked = clients
    .filter((c) => c.leaseUntil <= claim.now && hasPending(c.clientId))
    .sort((a, b) => (a.clientId < b.clientId ? -1 : 1))
    .at(0);
  const clientId = picked?.clientId ?? claim.fresh;
  return {
    client: clientId === undefined ? undefined : claimed(picked, clientId, claim),
    forget,
  };
}

function claimed(
  picked: StoredClient | undefined,
  clientId: string,
  claim: QueueClaim,
): StoredClient {
  return {
    clientId,
    nextSeq: picked?.nextSeq ?? 1,
    owner: claim.owner,
    leaseUntil: claim.leaseUntil,
  };
}

/** This tab's connection to the replica is gone; `message` says why and how to recover. */
export class StorageClosedError extends Error {
  override readonly name = 'StorageClosedError';
}

export const META_KEY = 'meta';

/** Whether `change` may overwrite `existing` (older or equal versions are skipped). */
export function isNewer(
  change: { readonly version: number },
  existing: StoredRecord | undefined,
): boolean {
  return existing === undefined || change.version > existing.version;
}

/** The record a change produces, or `undefined` when it leaves the stored row as it is. */
export function recordFor(
  change: StoredChange,
  existing: StoredRecord | undefined,
): StoredRecord | undefined {
  if (!isNewer(change, existing)) return undefined;
  switch (change.kind) {
    case 'upsert':
      return {
        id: change.row.id,
        version: change.version,
        archived: existing?.row ? existing.archived : false,
        row: change.row,
      };
    case 'archive':
    case 'unarchive':
      // Archiving a row this replica never had changes nothing.
      if (!existing?.row) return undefined;
      return { ...existing, version: change.version, archived: change.kind === 'archive' };
    case 'delete':
      return { id: change.id, version: change.version, archived: false, row: null };
  }
}

/** A fresh generation id. Uniqueness, not secrecy, is what matters. */
export function newGeneration(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
