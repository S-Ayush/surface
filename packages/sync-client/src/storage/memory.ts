/**
 * In-memory storage: the fallback when IndexedDB is unavailable or full
 * (SPEC-002 E6). Same contract as the IndexedDB storage; nothing survives a
 * reload.
 */
import type {
  BootstrapRecord,
  BootstrapStart,
  RowPage,
  StoredChange,
  StoredMeta,
  StoredRecord,
  SyncStorage,
} from './types.js';
import { StorageFencedError, newGeneration, recordFor } from './types.js';

/** Like an async function: a throw becomes a rejected promise, as with IndexedDB. */
const settle = <T>(operation: () => T): Promise<T> =>
  new Promise((resolve) => resolve(operation()));

export class MemoryStorage implements SyncStorage {
  readonly kind = 'memory';
  #meta: StoredMeta | undefined;
  readonly #rows = new Map<string, Map<string, StoredRecord>>();

  constructor(models: Iterable<string>) {
    for (const model of models) this.#rows.set(model, new Map());
  }

  readMeta(): Promise<StoredMeta | undefined> {
    return settle(() => this.#meta);
  }

  beginBootstrap(start: BootstrapStart): Promise<string> {
    return settle(() => {
      for (const rows of this.#rows.values()) rows.clear();
      const generation = newGeneration();
      this.#meta = { ...start, generation, state: 'bootstrapping' };
      return generation;
    });
  }

  writeBootstrapRows(generation: string, rows: readonly BootstrapRecord[]): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      for (const { model, row, archived } of rows) {
        const record = { id: row.id, version: meta.lastSyncId, archived, row };
        this.#table(model).set(row.id, record);
      }
    });
  }

  finishBootstrap(generation: string): Promise<void> {
    return settle(() => {
      this.#meta = { ...this.#check(generation), state: 'ready' };
    });
  }

  readRows(model: string, after: string | undefined, limit: number): Promise<RowPage> {
    return settle(() => {
      const table = this.#table(model);
      const ids = [...table.keys()].sort();
      const start = after === undefined ? 0 : ids.findIndex((id) => id > after);
      const page = start === -1 ? [] : ids.slice(start, start + limit);
      const rows = page.flatMap((id) => {
        const record = table.get(id);
        return record?.row ? [{ row: record.row, archived: record.archived }] : [];
      });
      return { rows, next: page.length === limit ? page.at(-1) : undefined };
    });
  }

  applyChanges(
    generation: string,
    changes: readonly StoredChange[],
    lastSyncId: number,
  ): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      // All or nothing, like the IndexedDB transaction: check every model first.
      for (const change of changes) this.#table(change.model);
      for (const change of changes) {
        const table = this.#table(change.model);
        const id = change.kind === 'upsert' ? change.row.id : change.id;
        const record = recordFor(change, table.get(id));
        if (record) table.set(id, record);
      }
      this.#meta = { ...meta, lastSyncId: Math.max(meta.lastSyncId, lastSyncId) };
    });
  }

  clear(): Promise<void> {
    return settle(() => {
      for (const rows of this.#rows.values()) rows.clear();
      this.#meta = undefined;
    });
  }

  close(): Promise<void> {
    return settle(() => undefined);
  }

  #check(generation: string): StoredMeta {
    if (this.#meta?.generation !== generation) throw new StorageFencedError();
    return this.#meta;
  }

  #table(model: string): Map<string, StoredRecord> {
    const table = this.#rows.get(model);
    if (table === undefined) throw new Error(`Unknown model ${model}`);
    return table;
  }
}
