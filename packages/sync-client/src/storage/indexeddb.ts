/**
 * IndexedDB storage (PLAN-002 S6), meant to run inside the storage worker.
 * Object stores: `meta`, the mutation queue (`clients`, and `pending` keyed by
 * `[clientId, seq]`; PLAN-002 S8), the on-demand teams (`subscriptions`; PLAN-011 S4c) and one
 * `row:<Model>` store per synced model, keyed by row id. When the store list changes, the database version is
 * bumped and the row stores are rebuilt; the queue survives.
 *
 * Every write transaction re-reads `meta` and checks the generation first (the
 * fence described in `types.ts`).
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { openDB } from 'idb';
import type {
  BootstrapRecord,
  BootstrapStart,
  OnDemandTeams,
  PartialWrite,
  PendingRecord,
  ClaimedQueue,
  QueueClaim,
  QueueSnapshot,
  QueueWrite,
  RowPage,
  StoredChange,
  StoredClient,
  StoredMeta,
  StoredRecord,
  SyncStorage,
  TeamRemoval,
} from './types.js';
import type { ReadRecords } from './partial-plan.js';
import {
  partialWriteModels,
  planPartialWrite,
  planTeamRemoval,
  shapeModels,
} from './partial-plan.js';
import {
  META_KEY,
  QueueFencedError,
  StorageClosedError,
  StorageFencedError,
  advanceTeamThrough,
  changedId,
  dropTeamThrough,
  newGeneration,
  planClaim,
  recordFor,
  startingTeamThrough,
  touchedOnDemand,
} from './types.js';

const META_STORE = 'meta';
const PENDING_STORE = 'pending';
const CLIENTS_STORE = 'clients';
const QUEUE_STORES = [CLIENTS_STORE, PENDING_STORE];
/** Survives bootstraps and upgrades, like the queue (SPEC-011 §5.7: per replica). */
const SUBSCRIPTIONS_STORE = 'subscriptions';
const ON_DEMAND_KEY = 'onDemand';
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
    const wanted = new Set([
      META_STORE,
      ...QUEUE_STORES,
      SUBSCRIPTIONS_STORE,
      ...models.map(rowStore),
    ]);
    // Filled in once open; the version-change callbacks below may fire any time after.
    const opened: { storage?: IndexedDbStorage } = {};
    const callbacks = {
      upgrade(db: IDBPDatabase) {
        for (const store of [...db.objectStoreNames]) {
          // Row stores are rebuilt from the server; the queue must survive (E8).
          if (!wanted.has(store) || store === META_STORE) db.deleteObjectStore(store);
        }
        for (const store of wanted) {
          if (!db.objectStoreNames.contains(store)) {
            const outOfLine = store === META_STORE || store === SUBSCRIPTIONS_STORE;
            db.createObjectStore(store, outOfLine ? undefined : { keyPath: storeKey(store) });
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
    const meta: StoredMeta = {
      ...start,
      generation,
      state: 'bootstrapping',
      teamThrough: startingTeamThrough(start),
    };
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
    teams?: readonly string[],
  ): Promise<void> {
    const models = [...new Set(changes.map((c) => c.model))];
    const tx = this.#write(models.map((m) => this.#rowStore(m)));
    const meta = await fence(tx, generation);
    for (const change of changes) {
      const store = tx.objectStore(rowStore(change.model));
      const id = changedId(change);
      const existing: unknown = await store.get(id);
      const record = recordFor(change, isStoredRecord(existing) ? existing : undefined);
      if (record) await store.put(record);
    }
    const teamThrough = advanceTeamThrough(meta.teamThrough, teams, lastSyncId);
    const next: StoredMeta = {
      ...meta,
      lastSyncId: Math.max(meta.lastSyncId, lastSyncId),
      ...(teamThrough === undefined ? {} : { teamThrough }),
    };
    await tx.objectStore(META_STORE).put(next, META_KEY);
    await tx.done;
  }

  async writePartialRows(generation: string, write: PartialWrite): Promise<void> {
    const models = partialWriteModels(write);
    const tx = this.#write(models.map((m) => this.#rowStore(m)));
    const meta = await fence(tx, generation);
    const read = await readAll(tx, models);
    for (const { model, record } of planPartialWrite(write, read)) {
      await tx.objectStore(rowStore(model)).put(record);
    }
    const teamThrough = advanceTeamThrough(meta.teamThrough, write.teams, write.through) ?? {};
    await tx.objectStore(META_STORE).put({ ...meta, teamThrough } satisfies StoredMeta, META_KEY);
    await tx.done;
  }

  async removeTeamRows(generation: string, removal: TeamRemoval): Promise<void> {
    const models = shapeModels(removal.shape);
    const tx = this.#write(models.map((m) => this.#rowStore(m)));
    const meta = await fence(tx, generation);
    const read = await readAll(tx, models);
    for (const { model, id } of planTeamRemoval(removal, read)) {
      await tx.objectStore(rowStore(model)).delete(id);
    }
    const teamThrough = dropTeamThrough(meta.teamThrough, removal.teams);
    await tx.objectStore(META_STORE).put({ ...meta, teamThrough } satisfies StoredMeta, META_KEY);
    await tx.done;
  }

  async readOnDemand(): Promise<readonly string[]> {
    const value: unknown = await this.#open().get(SUBSCRIPTIONS_STORE, ON_DEMAND_KEY);
    return isTeamList(value) ? value : [];
  }

  async touchOnDemand(teamId: string, limit: number): Promise<OnDemandTeams> {
    const tx = this.#open().transaction(SUBSCRIPTIONS_STORE, 'readwrite');
    const value: unknown = await tx.store.get(ON_DEMAND_KEY);
    const result = touchedOnDemand(isTeamList(value) ? value : [], teamId, limit);
    await tx.store.put([...result.teams], ON_DEMAND_KEY);
    await tx.done;
    return result;
  }

  async readQueue(): Promise<QueueSnapshot> {
    const tx = this.#open().transaction(QUEUE_STORES);
    const [clients, pending] = await Promise.all([
      tx.objectStore(CLIENTS_STORE).getAll(),
      tx.objectStore(PENDING_STORE).getAll(),
    ]);
    // `pending` is ordered by its `[clientId, seq]` key; other entries are skipped.
    return {
      clients: clients.filter(isStoredClient),
      pending: pending.filter(isPendingRecord).map(withoutKey),
    };
  }

  async claimQueue(claim: QueueClaim): Promise<ClaimedQueue | undefined> {
    const tx = this.#open().transaction(QUEUE_STORES, 'readwrite');
    const [clients, records] = await Promise.all([
      tx.objectStore(CLIENTS_STORE).getAll(),
      tx.objectStore(PENDING_STORE).getAll(),
    ]);
    // Ordered by the `[clientId, seq]` key.
    const pending = records.filter(isPendingRecord).map(withoutKey);
    const waiting = new Set(pending.map((record) => record.clientId));
    const plan = planClaim(clients.filter(isStoredClient), claim, (id) => waiting.has(id));
    // Forgotten queues are empty: only their client records go.
    for (const clientId of plan.forget) await tx.objectStore(CLIENTS_STORE).delete(clientId);
    const { client } = plan;
    if (client !== undefined) await tx.objectStore(CLIENTS_STORE).put(client);
    await tx.done;
    if (client === undefined) return undefined;
    return { client, pending: pending.filter((record) => record.clientId === client.clientId) };
  }

  async writeQueue(write: QueueWrite): Promise<void> {
    const tx = this.#open().transaction(QUEUE_STORES, 'readwrite');
    const clients = tx.objectStore(CLIENTS_STORE);
    const current: unknown = await clients.get(write.clientId);
    if (!isStoredClient(current) || current.owner !== write.owner) {
      tx.done.catch(() => undefined);
      tx.abort();
      throw new QueueFencedError();
    }
    await clients.put({
      ...current,
      nextSeq: write.nextSeq ?? current.nextSeq,
      leaseUntil: write.leaseUntil ?? current.leaseUntil,
    } satisfies StoredClient);
    const pending = tx.objectStore(PENDING_STORE);
    for (const seq of write.remove ?? []) await pending.delete([write.clientId, seq]);
    for (const record of write.put ?? []) {
      await pending.put({ ...record, key: [record.clientId, record.seq] });
    }
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
  if (store === PENDING_STORE) return 'key';
  return store === CLIENTS_STORE ? 'clientId' : 'id';
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

/** Every record of `models`, read in `tx` before it writes. */
async function readAll(tx: Tx, models: readonly string[]): Promise<ReadRecords> {
  const records = new Map<string, StoredRecord[]>();
  for (const model of models) {
    const values: unknown[] = await tx.objectStore(rowStore(model)).getAll();
    records.set(model, values.filter(isStoredRecord));
  }
  return (model) => records.get(model) ?? [];
}

function isTeamList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((team) => typeof team === 'string');
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
    (value.state === 'bootstrapping' || value.state === 'ready') &&
    (value.teamThrough === undefined || isTeamThrough(value.teamThrough))
  );
}

function isTeamThrough(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every((id) => typeof id === 'number');
}

function isStoredClient(value: unknown): value is StoredClient {
  return (
    isObject(value) &&
    typeof value.clientId === 'string' &&
    typeof value.nextSeq === 'number' &&
    typeof value.owner === 'string' &&
    typeof value.leaseUntil === 'number'
  );
}

function isPendingRecord(value: unknown): value is PendingRecord & { key: unknown } {
  return (
    isObject(value) &&
    typeof value.clientId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.op === 'string' &&
    typeof value.at === 'string' &&
    'input' in value &&
    (value.lastSyncId === undefined || typeof value.lastSyncId === 'number')
  );
}

function withoutKey({ key: _key, ...record }: PendingRecord & { key: unknown }): PendingRecord {
  return record;
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
