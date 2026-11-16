/**
 * Open the replica storage: IndexedDB in a worker when possible, IndexedDB on
 * this thread where workers are missing, and memory when IndexedDB is
 * unavailable, e.g. in some private-browsing modes (SPEC-002 E6).
 */
import { IndexedDbStorage } from './indexeddb.js';
import { MemoryStorage } from './memory.js';
import type { MessagePortLike } from './rpc.js';
import { connectStorage } from './rpc.js';
import type { ContentModelRef, SyncStorage } from './types.js';

/** `surface-<workspaceId>-<userId>` (PLAN-002 S6): one replica per user per workspace. */
export function replicaName(workspaceId: string, userId: string): string {
  return `surface-${workspaceId}-${userId}`;
}

export interface OpenStorageResult {
  readonly storage: SyncStorage;
  /** Why storage fell back to memory, for the warning banner; `undefined` if it persists. */
  readonly fallbackReason: string | undefined;
}

/**
 * Opens the replica `name` for `models`. `content` names the content models among them
 * (SPEC-011 §5.4, PLAN-011 S5b): a connector that ignores it stores their rows like eager ones.
 */
export type StorageConnector = (
  name: string,
  models: readonly string[],
  content?: readonly ContentModelRef[],
) => Promise<SyncStorage>;

export interface WorkerLike extends MessagePortLike {
  terminate(): void;
}

/**
 * IndexedDB in a worker made by `createWorker`, else IndexedDB on this
 * thread: when there are no workers, and also when the worker fails. A worker
 * can fail where IndexedDB works (a CSP without `worker-src`, a module that
 * does not load, an open that times out), and that must not cost persistence.
 */
export async function connectWithFallback(
  name: string,
  models: readonly string[],
  createWorker: (() => WorkerLike) | undefined,
  content: readonly ContentModelRef[] = [],
): Promise<SyncStorage> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
  if (createWorker === undefined) return IndexedDbStorage.open(name, models, content);
  let worker: WorkerLike | undefined;
  try {
    const created = (worker = createWorker());
    return await connectStorage(
      created,
      name,
      models,
      { onClose: () => created.terminate() },
      content,
    );
  } catch {
    worker?.terminate();
    return IndexedDbStorage.open(name, models, content);
  }
}

/** The default connector: a module worker if available (see `connectWithFallback`). */
export const defaultConnector: StorageConnector = (name, models, content = []) =>
  connectWithFallback(
    name,
    models,
    typeof Worker === 'undefined'
      ? undefined
      : // Vite bundles this pattern as a separate worker chunk.
        () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    content,
  );

export async function openStorage(
  name: string,
  models: readonly string[],
  connect: StorageConnector = defaultConnector,
  content: readonly ContentModelRef[] = [],
): Promise<OpenStorageResult> {
  try {
    return { storage: await connect(name, models, content), fallbackReason: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { storage: new MemoryStorage(models, content), fallbackReason: reason };
  }
}

/**
 * Delete the whole replica database, whatever stores it holds (SPEC-002 §3.7: sign-out deletes
 * the replica as a unit, so stores other slices add are covered). Resolves when it is deleted, or
 * when another tab still holds a connection: the delete then runs as soon as that tab closes its
 * own (it does on the session-end signal), and sign-out must not wait for it. No-op without
 * IndexedDB (the memory fallback holds nothing outside the store).
 */
export function deleteReplicaDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Could not delete ${name}`));
    };
  });
}
