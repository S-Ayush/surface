/**
 * Open the replica storage: IndexedDB in a worker when possible, IndexedDB on
 * this thread where workers are missing, and memory when IndexedDB is
 * unavailable, e.g. in some private-browsing modes (SPEC-002 E6).
 */
import { IndexedDbStorage } from './indexeddb.js';
import { MemoryStorage } from './memory.js';
import type { MessagePortLike } from './rpc.js';
import { connectStorage } from './rpc.js';
import type { SyncStorage } from './types.js';

/** `surface-<workspaceId>-<userId>` (PLAN-002 S6): one replica per user per workspace. */
export function replicaName(workspaceId: string, userId: string): string {
  return `surface-${workspaceId}-${userId}`;
}

export interface OpenStorageResult {
  readonly storage: SyncStorage;
  /** Why storage fell back to memory, for the warning banner; `undefined` if it persists. */
  readonly fallbackReason: string | undefined;
}

export type StorageConnector = (name: string, models: readonly string[]) => Promise<SyncStorage>;

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
): Promise<SyncStorage> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
  if (createWorker === undefined) return IndexedDbStorage.open(name, models);
  let worker: WorkerLike | undefined;
  try {
    const created = (worker = createWorker());
    return await connectStorage(created, name, models, { onClose: () => created.terminate() });
  } catch {
    worker?.terminate();
    return IndexedDbStorage.open(name, models);
  }
}

/** The default connector: a module worker if available (see `connectWithFallback`). */
export const defaultConnector: StorageConnector = (name, models) =>
  connectWithFallback(
    name,
    models,
    typeof Worker === 'undefined'
      ? undefined
      : // Vite bundles this pattern as a separate worker chunk.
        () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  );

export async function openStorage(
  name: string,
  models: readonly string[],
  connect: StorageConnector = defaultConnector,
): Promise<OpenStorageResult> {
  try {
    return { storage: await connect(name, models), fallbackReason: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { storage: new MemoryStorage(models), fallbackReason: reason };
  }
}
