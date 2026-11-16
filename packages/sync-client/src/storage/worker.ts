/**
 * Entry point of the IndexedDB worker (SPEC-002 §5.1). Started by
 * `openStorage` as a module worker; the main thread talks to it through
 * `connectStorage`.
 */
import { IndexedDbStorage } from './indexeddb.js';
import type { MessagePortLike } from './rpc.js';
import { serveStorage } from './rpc.js';

// Inside a worker the global scope is the message port; the DOM lib types it as Window.
const scope = globalThis as unknown as MessagePortLike;

serveStorage(scope, (name, models, content) => IndexedDbStorage.open(name, models, content));
