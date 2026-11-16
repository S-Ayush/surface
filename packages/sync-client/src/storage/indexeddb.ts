/**
 * IndexedDB storage (PLAN-002 S6), meant to run inside the storage worker.
 * Object stores: `meta`, the mutation queue (`clients`, and `pending` keyed by
 * `[clientId, seq]`; PLAN-002 S8), the on-demand teams (`subscriptions`; PLAN-011 S4c), the
 * hydrated set (`hydrated`, parent id → last opened; PLAN-011 S5b) and one `row:<Model>` store per
 * synced model, keyed by row id. A content model's store has the index `parent` on its parent
 * field (SPEC-011 §5.4). When the stores or those indexes change, the database version is bumped
 * and the row stores are rebuilt; the queue survives.
 *
 * Every write transaction re-reads `meta` and checks the generation first (the
 * fence described in `types.ts`).
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { openDB } from 'idb';
import type {
  BootstrapRecord,
  BootstrapStart,
  ContentMark,
  ContentModelRef,
  ContentRead,
  ContentRecord,
  ContentWrite,
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
import {
  contentByModel,
  contentRowIsNewer,
  replayed,
  goneParents,
  sweptIssues,
  teamIssues,
  upsertParent,
} from './content-plan.js';
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
/** The hydrated set (SPEC-011 §5.4), cleared with the rows. */
const HYDRATED_STORE = 'hydrated';
/** The index of a content model's store on its parent field. */
const PARENT_INDEX = 'parent';
const rowStore = (model: string) => `row:${model}`;
const parentKeyPath = (ref: ContentModelRef) => `row.${ref.field}`;

/** A parent in the hydrated set. */
interface HydratedMark {
  readonly id: string;
  /** Epoch ms; 0 for a parent hydrated by its `I` packet and never opened. */
  readonly openedAt: number;
}

type Tx = IDBPTransaction<unknown, string[], 'readwrite'>;

export class IndexedDbStorage implements SyncStorage {
  readonly kind = 'indexeddb';
  #db: IDBPDatabase | undefined;
  #closedReason = 'Local storage is closed.';
  readonly #models: ReadonlySet<string>;
  readonly #content: readonly ContentModelRef[];
  readonly #contentByModel: ReadonlyMap<string, ContentModelRef>;
  readonly #parentModels: ReadonlySet<string>;

  private constructor(
    db: IDBPDatabase,
    models: readonly string[],
    content: readonly ContentModelRef[],
  ) {
    this.#db = db;
    this.#models = new Set(models);
    this.#content = content.filter((ref) => this.#models.has(ref.model));
    this.#contentByModel = contentByModel(this.#content);
    this.#parentModels = new Set(this.#content.map((ref) => ref.parent));
  }

  /**
   * Open (or create, or migrate) the replica database `name` for these models; `content` names
   * the content models among them, whose stores get the parent index.
   */
  static async open(
    name: string,
    models: readonly string[],
    content: readonly ContentModelRef[] = [],
  ): Promise<IndexedDbStorage> {
    const wanted = new Set([
      META_STORE,
      ...QUEUE_STORES,
      SUBSCRIPTIONS_STORE,
      HYDRATED_STORE,
      ...models.map(rowStore),
    ]);
    const indexed = new Map(
      content.filter((ref) => models.includes(ref.model)).map((ref) => [rowStore(ref.model), ref]),
    );
    // Filled in once open; the version-change callbacks below may fire any time after.
    const opened: { storage?: IndexedDbStorage } = {};
    const callbacks = {
      upgrade(
        db: IDBPDatabase,
        _old: number,
        _new: number | null,
        tx: IDBPTransaction<unknown, string[], 'versionchange'>,
      ) {
        for (const store of [...db.objectStoreNames]) {
          // Row stores are rebuilt from the server; the queue must survive (E8). A content store
          // without its parent index (made before PLAN-011 S5b) is rebuilt with it.
          const ref = indexed.get(store);
          const stale = ref !== undefined && !hasParentIndex(tx.objectStore(store), ref);
          if (!wanted.has(store) || store === META_STORE || stale) db.deleteObjectStore(store);
        }
        for (const store of wanted) {
          if (!db.objectStoreNames.contains(store)) {
            const outOfLine = store === META_STORE || store === SUBSCRIPTIONS_STORE;
            const created = db.createObjectStore(
              store,
              outOfLine ? undefined : { keyPath: storeKey(store) },
            );
            const ref = indexed.get(store);
            if (ref !== undefined) created.createIndex(PARENT_INDEX, parentKeyPath(ref));
          }
        }
      },
      // Another tab is upgrading or deleting the database: let it, and stop writing. A delete
      // (`blockedVersion` null) is the user logging out there (SPEC-012 §3.12 item 3): this is
      // what closes this tab's connection, offline too, before any 4001 arrives.
      blocking(_currentVersion: number, blockedVersion: number | null) {
        if (opened.storage)
          opened.storage.#stop(
            blockedVersion === null
              ? 'You logged out in another tab.'
              : 'Surface was updated in another tab. Reload this tab to keep saving offline.',
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
    const sameStores =
      stores.size === wanted.size && [...wanted].every((store) => stores.has(store));
    const ready =
      sameStores &&
      [...indexed].every(([store, ref]) =>
        hasParentIndex(db.transaction(store).objectStore(store), ref),
      );
    if (!ready) {
      const version = db.version + 1;
      db.close();
      db = await openUnblocked(name, version, callbacks);
    }
    opened.storage = new IndexedDbStorage(db, models, content);
    return opened.storage;
  }

  async readMeta(): Promise<StoredMeta | undefined> {
    const value: unknown = await this.#open().get(META_STORE, META_KEY);
    return isStoredMeta(value) ? value : undefined;
  }

  async beginBootstrap(start: BootstrapStart): Promise<string> {
    const generation = newGeneration();
    const tx = this.#write([...[...this.#models].map(rowStore), HYDRATED_STORE]);
    for (const model of this.#models) await tx.objectStore(rowStore(model)).clear();
    await tx.objectStore(HYDRATED_STORE).clear();
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
    hydrate?: readonly string[],
  ): Promise<void> {
    const marks = hydrate ?? [];
    const gone = goneParents(changes, this.#content);
    const content = marks.length > 0 || gone.size > 0 || changes.some((c) => this.#isContent(c));
    const models = [
      ...new Set([
        ...changes.map((c) => c.model),
        ...(content ? this.#content.map((ref) => ref.model) : []),
      ]),
    ];
    const stores = models.map((m) => this.#rowStore(m));
    const tx = this.#write(content ? [...stores, HYDRATED_STORE] : stores);
    const meta = await fence(tx, generation);
    const hydrated = new Map<string, boolean>();
    const isHydrated = async (parent: string): Promise<boolean> => {
      const known = hydrated.get(parent);
      if (known !== undefined) return known;
      const found = (await tx.objectStore(HYDRATED_STORE).get(parent)) !== undefined;
      hydrated.set(parent, found);
      return found;
    };
    for (const parent of marks) {
      if (await isHydrated(parent)) continue;
      await tx.objectStore(HYDRATED_STORE).put({ id: parent, openedAt: 0 } satisfies HydratedMark);
      hydrated.set(parent, true);
    }
    for (const change of changes) {
      // SPEC-011 §5.3 step 4: content of a parent no tab hydrated would be partial.
      const parent = upsertParent(change, this.#contentByModel);
      if (parent !== undefined && !(await isHydrated(parent))) continue;
      const store = tx.objectStore(rowStore(change.model));
      const id = changedId(change);
      const existing: unknown = await store.get(id);
      const record = recordFor(change, isStoredRecord(existing) ? existing : undefined);
      if (record) await store.put(record);
    }
    await this.#dropContent(tx, gone, lastSyncId);
    const teamThrough = advanceTeamThrough(meta.teamThrough, teams, lastSyncId);
    const next: StoredMeta = {
      ...meta,
      lastSyncId: Math.max(meta.lastSyncId, lastSyncId),
      ...(teamThrough === undefined ? {} : { teamThrough }),
    };
    await tx.objectStore(META_STORE).put(next, META_KEY);
    await tx.done;
  }

  async writeContent(generation: string, write: ContentWrite): Promise<void> {
    const models = [...new Set([...this.#content.map((ref) => ref.model), ...this.#parentModels])];
    const tx = this.#write([...models.map((m) => this.#rowStore(m)), HYDRATED_STORE]);
    await fence(tx, generation);
    // A parent purged (or removed) before this answer is skipped, rows and all (E23).
    const parents = new Set<string>();
    for (const parent of write.parents) {
      for (const model of this.#parentModels) {
        const stored: unknown = await tx.objectStore(rowStore(model)).get(parent);
        if (isStoredRecord(stored) && stored.row !== null) parents.add(parent);
      }
    }
    for (const { model, row, archived } of write.rows) {
      const ref = this.#contentByModel.get(model);
      if (ref === undefined || !parents.has(String(row[ref.field]))) continue;
      const store = tx.objectStore(rowStore(model));
      const existing: unknown = await store.get(row.id);
      if (!contentRowIsNewer(write.version, isStoredRecord(existing) ? existing : undefined)) {
        continue;
      }
      await store.put({ id: row.id, version: write.version, archived, row } satisfies StoredRecord);
    }
    for (const change of replayed(write.replay, parents, this.#contentByModel)) {
      const store = tx.objectStore(rowStore(change.model));
      const id = changedId(change);
      const existing: unknown = await store.get(id);
      const record = recordFor(change, isStoredRecord(existing) ? existing : undefined);
      if (record) await store.put(record);
    }
    for (const parent of parents) {
      const mark: HydratedMark = { id: parent, openedAt: write.openedAt };
      await tx.objectStore(HYDRATED_STORE).put(mark);
    }
    await tx.done;
  }

  async readContent(generation: string, parent: string): Promise<ContentRead> {
    const stores = this.#content.map((ref) => rowStore(ref.model));
    const tx = this.#open().transaction([...stores, HYDRATED_STORE, META_STORE]);
    const meta: unknown = await tx.objectStore(META_STORE).get(META_KEY);
    if (!isStoredMeta(meta) || meta.generation !== generation) {
      tx.done.catch(() => undefined);
      throw new StorageFencedError();
    }
    const hydrated = (await tx.objectStore(HYDRATED_STORE).get(parent)) !== undefined;
    const records: ContentRecord[] = [];
    for (const ref of this.#content) {
      const values: unknown[] = await tx
        .objectStore(rowStore(ref.model))
        .index(PARENT_INDEX)
        .getAll(parent);
      for (const value of values) {
        if (!isStoredRecord(value) || value.row === null) continue;
        const { version, archived, row } = value;
        records.push({ model: ref.model, version, archived, row });
      }
    }
    await tx.done;
    return { hydrated, records };
  }

  async readHydrated(): Promise<readonly string[]> {
    const keys = await this.#open().getAllKeys(HYDRATED_STORE);
    return keys.filter((key): key is string => typeof key === 'string');
  }

  async readContentMarks(): Promise<readonly ContentMark[]> {
    const values: unknown[] = await this.#open().getAll(HYDRATED_STORE);
    return values.filter(isHydratedMark).map(({ id, openedAt }) => ({ parent: id, openedAt }));
  }

  async touchContent(
    generation: string,
    parents: readonly string[],
    openedAt: number,
  ): Promise<void> {
    const tx = this.#write([HYDRATED_STORE]);
    await fence(tx, generation);
    const store = tx.objectStore(HYDRATED_STORE);
    for (const parent of parents) {
      const stored: unknown = await store.get(parent);
      if (!isHydratedMark(stored) || stored.openedAt >= openedAt) continue;
      await store.put({ id: parent, openedAt } satisfies HydratedMark);
    }
    await tx.done;
  }

  async evictContent(
    generation: string,
    marks: readonly ContentMark[],
  ): Promise<readonly string[]> {
    const tx = this.#write([...this.#content.map((ref) => rowStore(ref.model)), HYDRATED_STORE]);
    await fence(tx, generation);
    const evicted: string[] = [];
    for (const { parent, openedAt } of marks) {
      const stored: unknown = await tx.objectStore(HYDRATED_STORE).get(parent);
      // Gone already, or opened again since the caller read it: kept.
      if (!isHydratedMark(stored) || stored.openedAt > openedAt) continue;
      await tx.objectStore(HYDRATED_STORE).delete(parent);
      for (const ref of this.#content) {
        const store = tx.objectStore(rowStore(ref.model));
        // The parent index holds live rows only: a tombstone's row is null.
        const keys = await store.index(PARENT_INDEX).getAllKeys(parent);
        for (const key of keys) await store.delete(key);
      }
      evicted.push(parent);
    }
    await tx.done;
    return evicted;
  }

  async writePartialRows(generation: string, write: PartialWrite): Promise<void> {
    const models = partialWriteModels(write);
    const tx = this.#write([...models.map((m) => this.#rowStore(m)), HYDRATED_STORE]);
    const meta = await fence(tx, generation);
    const read = await readAll(tx, models);
    const puts = planPartialWrite(write, read);
    for (const { model, record } of puts) {
      await tx.objectStore(rowStore(model)).put(record);
    }
    for (const issue of sweptIssues(write, puts)) {
      await tx.objectStore(HYDRATED_STORE).delete(issue);
    }
    const teamThrough = advanceTeamThrough(meta.teamThrough, write.teams, write.through) ?? {};
    await tx.objectStore(META_STORE).put({ ...meta, teamThrough } satisfies StoredMeta, META_KEY);
    await tx.done;
  }

  async removeTeamRows(generation: string, removal: TeamRemoval): Promise<void> {
    const models = shapeModels(removal.shape);
    const tx = this.#write([...models.map((m) => this.#rowStore(m)), HYDRATED_STORE]);
    const meta = await fence(tx, generation);
    const read = await readAll(tx, models);
    // Kept issues (held through `user:`) lose their content and mark too (§5.7).
    for (const issue of teamIssues(removal.shape.issue, removal.teams, read)) {
      await tx.objectStore(HYDRATED_STORE).delete(issue);
    }
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
    const tx = this.#write([...[...this.#models].map(rowStore), HYDRATED_STORE]);
    for (const model of this.#models) await tx.objectStore(rowStore(model)).clear();
    await tx.objectStore(HYDRATED_STORE).clear();
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

  /** A change content rules apply to: a content row, or the deletion of a content parent. */
  #isContent(change: StoredChange): boolean {
    return (
      this.#contentByModel.has(change.model) ||
      (change.kind === 'delete' && this.#parentModels.has(change.model))
    );
  }

  /** The content and marks of parents a batch deleted, as tombstones at `version` (§5.3 step 4). */
  async #dropContent(tx: Tx, parents: ReadonlySet<string>, version: number): Promise<void> {
    for (const parent of parents) {
      await tx.objectStore(HYDRATED_STORE).delete(parent);
      for (const ref of this.#content) {
        const store = tx.objectStore(rowStore(ref.model));
        const values: unknown[] = await store.index(PARENT_INDEX).getAll(parent);
        for (const value of values) {
          if (!isStoredRecord(value) || value.version >= version) continue;
          const tombstone: StoredRecord = { id: value.id, version, archived: false, row: null };
          await store.put(tombstone);
        }
      }
    }
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

/** Whether a content model's store has the parent index on the right field. */
function hasParentIndex(
  store: {
    readonly indexNames: DOMStringList;
    index(name: string): { readonly keyPath: string | string[] };
  },
  ref: ContentModelRef,
): boolean {
  return (
    store.indexNames.contains(PARENT_INDEX) &&
    store.index(PARENT_INDEX).keyPath === parentKeyPath(ref)
  );
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

function isHydratedMark(value: unknown): value is HydratedMark {
  return isObject(value) && typeof value.id === 'string' && typeof value.openedAt === 'number';
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
