import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '../../src/storage/indexeddb.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { connectStorage, serveStorage } from '../../src/storage/rpc.js';
import type { ContentModelRef, SyncStorage } from '../../src/storage/types.js';

let counter = 0;
/** A database name no other test uses (fake-indexeddb is global per file). */
export function uniqueName(prefix = 'surface-test'): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

const openPorts: MessagePort[] = [];

/** Run `IndexedDbStorage` behind the worker RPC, over a real MessageChannel. */
export async function connectViaRpc(
  name: string,
  models: readonly string[],
  content: readonly ContentModelRef[] = [],
): Promise<SyncStorage> {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  serveStorage(port2, (dbName, modelNames, refs) =>
    IndexedDbStorage.open(dbName, modelNames, refs),
  );
  return connectStorage(port1, name, models, {}, content);
}

/** Node keeps the process alive while ports are open. */
export function closePorts(): void {
  for (const port of openPorts.splice(0)) port.close();
}

/**
 * Open two "tabs" on one replica. IndexedDB backends get two connections to
 * the same database; memory has no sharing across tabs, so both handles are
 * the same object (which still exercises the generation fence).
 */
export interface Backend {
  readonly name: string;
  open(
    dbName: string,
    models: readonly string[],
    content?: readonly ContentModelRef[],
  ): Promise<SyncStorage>;
}

const memories = new Map<string, MemoryStorage>();

export const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    open: (dbName, models, content = []) => {
      let storage = memories.get(dbName);
      if (storage === undefined) {
        memories.set(dbName, (storage = new MemoryStorage(models, content)));
      }
      return Promise.resolve(storage);
    },
  },
  {
    name: 'indexeddb',
    open: (dbName, models, content = []) => IndexedDbStorage.open(dbName, models, content),
  },
  { name: 'indexeddb via worker rpc', open: connectViaRpc },
];
