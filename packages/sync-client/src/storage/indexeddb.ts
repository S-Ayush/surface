/**
 * IndexedDB storage (PLAN-002 S6), meant to run inside the storage worker.
 * Object stores: `meta`, `pending` (PLAN-002 S8) and one `row:<Model>` store
 * per synced model, keyed by row id. When the model list changes, the database
 * version is bumped and the row stores are rebuilt; `pending` survives.
 *
 * Every write transaction re-reads `meta` and checks the generation first (the
 * fence described in `types.ts`).
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { openDB } from 'idb';
import type {
  BootstrapRecord,
  BootstrapStart,
  RowPage,
  StoredChange,
  StoredMeta,
  StoredRecord,
  SyncStorage,
} from './types.js';
import {
  META_KEY,
  StorageClosedError,
  StorageFencedError,
  newGeneration,
  recordFor,
} from './types.js';

const META_STORE = 'meta';
const PENDING_STORE = 'pending';
const rowStore = (model: string) => `row:${model}`;

type Tx = IDBPTransaction<unknown, string[], 'readwrite'>;

export class IndexedDbStorage implements SyncStorage {
  readonly kind = 'indexeddb';
  #db: IDBPDatabase | undefined;
  #closedReason = 'Local storage is closed.';
  readonly #models: ReadonlySet<string>;

  private constructor(db: IDBPDatabase, models: readonly string[]) {
    this.#db = db;
    this.#models = new Set(models);
  }

  /** Open (or create, or migrate) the replica database `name` for these models. */
  static async open(name: string, models: readonly string[]): Promise<IndexedDbStorage> {
    const wanted = new Set([META_STORE, PENDING_STORE, ...models.map(rowStore)]);
    // Filled in once open; the version-change callbacks below may fire any time after.
    const opened: { storage?: IndexedDbStorage } = {};
    const callbacks = {
      upgrade(db: IDBPDatabase) {
        for (const store of [...db.objectStoreNames]) {
          // Row stores are rebuilt from the server; pending mutations must survive (E8).
          if (!wanted.has(store) || store === META_STORE) db.deleteObjectStore(store);
        }
        for (const store of wanted) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(
              store,
              store === META_STORE ? undefined : { keyPath: storeKey(store) },
            );
          }
        }
      },
      // Another tab is upgrading or deleting the database: let it, and stop writing.
      blocking() {
        if (opened.storage)
          opened.storage.#stop(
            'Surface was updated in another tab. Reload this tab to keep saving offline.',
          );
      },
      terminated() {
        if (opened.storage)
          opened.storage.#stop(
            'The browser closed local storage. Reload the page to keep saving offline.',
          );
      },
    };

    let db = await openUnblocked(name, undefined, callbacks);
    const stores = new Set(db.objectStoreNames);
    if (stores.size !== wanted.size || [...wanted].some((store) => !stores.has(store))) {
      const version = db.version + 1;
      db.close();
      db = await openUnblocked(name, version, callbacks);
    }
    opened.storage = new IndexedDbStorage(db, models);
    return opened.storage;
  }

  async readMeta(): Promise<StoredMeta | undefined> {
    const value: unknown = await this.#open().get(META_STORE, META_KEY);
    return isStoredMeta(value) ? value : undefined;
  }

  async beginBootstrap(start: BootstrapStart): Promise<string> {
    const generation = newGeneration();
    const tx = this.#write([...this.#models].map(rowStore));
    for (const model of this.#models) await tx.objectStore(rowStore(model)).clear();
    const meta: StoredMeta = { ...start, generation, state: 'bootstrapping' };
    await tx.objectStore(META_STORE).put(meta, META_KEY);
    await tx.done;
    return generation;
  }

  async writeBootstrapRows(generation: string, rows: readonly BootstrapRecord[]): Promise<void> {
    const models = [...new Set(rows.map((r) => r.model))];
    // Bootstrap rows can be re-fetched, so trade durability for throughput (PLAN-002 risks).
    const tx = this.#write(
      models.map((m) => this.#rowStore(m)),
      'relaxed',
    );
    const meta = await fence(tx, generation);
    // Queue every put before awaiting, so the transaction stays busy; await them all so a
    // failed put (e.g. quota) rejects here rather than as an unhandled rejection.
    const puts = rows.map(({ model, row, archived }) => {
      const record: StoredRecord = { id: row.id, version: meta.lastSyncId, archived, row };
      return tx.objectStore(rowStore(model)).put(record);
    });
    await Promise.all([...puts, tx.done]);
  }

  async finishBootstrap(generation: string): Promise<void> {
    const tx = this.#write([]);
    const meta = await fence(tx, generation);
    await tx
      .objectStore(META_STORE)
      .put({ ...meta, state: 'ready' } satisfies StoredMeta, META_KEY);
    await tx.done;
  }

  async readRows(model: string, after: string | undefined, limit: number): Promise<RowPage> {
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const store = this.#open().transaction(this.#rowStore(model)).store;
    const [keys, values] = await Promise.all([
      store.getAllKeys(range, limit),
      store.getAll(range, limit),
    ]);
    // Page on the keys read, not the records kept: skipping an unreadable
    // record must not end the paging early.
    const last = keys.at(-1);
    const rows = values
      .filter(isStoredRecord)
      .flatMap((r) => (r.row ? [{ row: r.row, archived: r.archived }] : []));
    return { rows, next: keys.length === limit && typeof last === 'string' ? last : undefined };
  }

  async applyChanges(
    generation: string,
    changes: readonly StoredChange[],
    lastSyncId: number,
  ): Promise<void> {
    const models = [...new Set(changes.map((c) => c.model))];
    const tx = this.#write(models.map((m) => this.#rowStore(m)));
    const meta = await fence(tx, generation);
    for (const change of changes) {
      const store = tx.objectStore(rowStore(change.model));
      const id = change.kind === 'upsert' ? change.row.id : change.id;
      const existing: unknown = await store.get(id);
      const record = recordFor(change, isStoredRecord(existing) ? existing : undefined);
      if (record) await store.put(record);
    }
    const next: StoredMeta = { ...meta, lastSyncId: Math.max(meta.lastSyncId, lastSyncId) };
    await tx.objectStore(META_STORE).put(next, META_KEY);
    await tx.done;
  }

  async clear(): Promise<void> {
    const tx = this.#write([...this.#models].map(rowStore));
    for (const model of this.#models) await tx.objectStore(rowStore(model)).clear();
    await tx.objectStore(META_STORE).delete(META_KEY);
    await tx.done;
  }

  close(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
    return Promise.resolve();
  }

  #stop(reason: string): void {
    this.#db?.close();
    this.#db = undefined;
    this.#closedReason = reason;
  }

  #open(): IDBPDatabase {
    if (this.#db === undefined) throw new StorageClosedError(this.#closedReason);
    return this.#db;
  }

  #rowStore(model: string): string {
    if (!this.#models.has(model)) throw new Error(`Unknown model ${model}`);
    return rowStore(model);
  }

  /** A read-write transaction over `stores` plus `meta`. */
  #write(stores: string[], durability: IDBTransactionDurability = 'default'): Tx {
    return this.#open().transaction([META_STORE, ...stores], 'readwrite', { durability });
  }
}

/**
 * `openDB`, except that an upgrade blocked by another tab that won't close its
 * connection rejects instead of waiting indefinitely. If the open completes
 * later anyway, that connection is closed.
 */
function openUnblocked(
  name: string,
  version: number | undefined,
  callbacks: Parameters<typeof openDB>[2],
): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    openDB(name, version, {
      ...callbacks,
      blocked() {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            'Another Surface tab is using an older version. Close other Surface tabs and reload.',
          ),
        );
      },
    }).then(
      (db) => {
        if (settled) db.close();
        else {
          settled = true;
          resolve(db);
        }
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function storeKey(store: string): string {
  return store === PENDING_STORE ? 'key' : 'id';
}

/** Check the generation inside `tx`; abort and throw if another tab moved on. */
async function fence(tx: Tx, generation: string): Promise<StoredMeta> {
  const meta: unknown = await tx.objectStore(META_STORE).get(META_KEY);
  if (isStoredMeta(meta) && meta.generation === generation) return meta;
  // The abort rejects `tx.done`; nobody else awaits it on this path.
  tx.done.catch(() => undefined);
  tx.abort();
  throw new StorageFencedError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Our own data, but possibly written by an older app version: check before trusting it. */
function isStoredMeta(value: unknown): value is StoredMeta {
  return (
    isObject(value) &&
    typeof value.schemaHash === 'string' &&
    typeof value.generation === 'string' &&
    typeof value.lastSyncId === 'number' &&
    Array.isArray(value.groups) &&
    (value.state === 'bootstrapping' || value.state === 'ready')
  );
}

function isStoredRecord(value: unknown): value is StoredRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'number' &&
    typeof value.archived === 'boolean' &&
    (value.row === null || (isObject(value.row) && typeof value.row.id === 'string'))
  );
}
