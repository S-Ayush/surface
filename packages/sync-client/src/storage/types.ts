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
