/**
 * Runs a `SyncStorage` on the far side of a message port (the IndexedDB worker,
 * SPEC-002 §5.1), so bulk IDB work stays off the main thread. Requests and
 * responses are matched by id; errors keep their `name`, so a
 * `StorageFencedError` thrown in the worker is one on the main thread too.
 */
import type { SyncStorage } from './types.js';
import { StorageFencedError } from './types.js';

/** The part of `MessagePort` / `Worker` / worker `self` used here. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  /** `error` (Worker: script failed or crashed) and `messageerror` only end the connection. */
  addEventListener(
    type: 'message' | 'messageerror' | 'error',
    listener: (event: MessageEvent) => void,
  ): void;
  start?(): void;
}

/** How long the worker may take to open IndexedDB before start-up falls back to memory. */
export const OPEN_TIMEOUT_MS = 10_000;
/** How long one call may take; generous, since a 1,000-row chunk takes well under a second. */
export const CALL_TIMEOUT_MS = 30_000;

/** The storage worker failed, stopped answering, or was closed. Callers stop persisting. */
export class StorageUnavailableError extends Error {
  override readonly name = 'StorageUnavailableError';
}

export interface ConnectOptions {
  /** Runs after `close()`; the default connector terminates the worker here. */
  readonly onClose?: () => void;
}

type StorageMethod = Exclude<keyof SyncStorage, 'kind'>;

const STORAGE_METHODS = [
  'readMeta',
  'beginBootstrap',
  'writeBootstrapRows',
  'finishBootstrap',
  'readRows',
  'applyChanges',
  'clear',
  'close',
] as const satisfies readonly StorageMethod[];

interface Request {
  readonly id: number;
  readonly method: StorageMethod | 'open';
  readonly args: readonly unknown[];
}

type Response =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { name: string; message: string } };

function isRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'method' in value &&
    (value.method === 'open' || STORAGE_METHODS.some((m) => m === value.method)) &&
    'args' in value &&
    Array.isArray(value.args)
  );
}

function isResponse(value: unknown): value is Response {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

export type OpenStorage = (name: string, models: readonly string[]) => Promise<SyncStorage>;

/** Worker side: answer requests on `port`. The first request must be `open`. */
export function serveStorage(port: MessagePortLike, open: OpenStorage): void {
  let storage: Promise<SyncStorage> | undefined;

  const handle = async (request: Request): Promise<unknown> => {
    if (request.method === 'open') {
      const [name, models] = request.args;
      if (
        typeof name !== 'string' ||
        !Array.isArray(models) ||
        !models.every((m) => typeof m === 'string')
      ) {
        throw new Error('open needs a database name and a list of model names');
      }
      storage = open(name, models);
      return (await storage).kind;
    }
    if (storage === undefined) throw new Error('Storage is not open');
    const target = await storage;
    // Arguments come from our own main thread, typed by `connectStorage` below.
    const method = target[request.method] as (...args: readonly unknown[]) => Promise<unknown>;
    return method.apply(target, [...request.args]);
  };

  port.addEventListener('message', (event) => {
    const request: unknown = event.data;
    if (!isRequest(request)) return;
    handle(request).then(
      (value) => port.postMessage({ id: request.id, ok: true, value } satisfies Response),
      (error: unknown) => {
        const { name, message } = error instanceof Error ? error : new Error(String(error));
        port.postMessage({
          id: request.id,
          ok: false,
          error: { name, message },
        } satisfies Response);
      },
    );
  });
  port.start?.();
}

/**
 * Main-thread side: a `SyncStorage` whose calls run behind `port`. A worker
 * that errors or stops answering fails every pending and later call with
 * `StorageUnavailableError`, so nothing waits forever.
 */
export async function connectStorage(
  port: MessagePortLike,
  name: string,
  models: readonly string[],
  options: ConnectOptions = {},
): Promise<SyncStorage> {
  let nextId = 0;
  let failure: StorageUnavailableError | undefined;
  const waiting = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const fail = (error: StorageUnavailableError) => {
    failure ??= error;
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    waiting.clear();
  };

  port.addEventListener('message', (event) => {
    const response: unknown = event.data;
    if (!isResponse(response)) return;
    const pending = waiting.get(response.id);
    if (pending === undefined) return;
    waiting.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(revive(response.error));
  });
  const crashed = () => fail(new StorageUnavailableError('The local storage worker stopped.'));
  port.addEventListener('error', crashed);
  port.addEventListener('messageerror', crashed);
  port.start?.();

  const call = (
    method: Request['method'],
    args: readonly unknown[],
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        fail(
          new StorageUnavailableError(
            method === 'open'
              ? 'Local storage did not start in time.'
              : 'Local storage stopped responding.',
          ),
        );
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      port.postMessage({ id, method, args } satisfies Request);
    });

  const kind = await call('open', [name, [...models]], OPEN_TIMEOUT_MS);
  if (kind !== 'indexeddb' && kind !== 'memory') {
    throw new StorageUnavailableError('Local storage did not start.');
  }

  // Results come from our own worker running the same `SyncStorage` contract.
  const typed =
    <M extends StorageMethod>(method: M) =>
    (...args: Parameters<SyncStorage[M]>) =>
      call(method, args) as ReturnType<SyncStorage[M]>;

  return {
    kind,
    readMeta: typed('readMeta'),
    beginBootstrap: typed('beginBootstrap'),
    writeBootstrapRows: typed('writeBootstrapRows'),
    finishBootstrap: typed('finishBootstrap'),
    readRows: typed('readRows'),
    applyChanges: typed('applyChanges'),
    clear: typed('clear'),
    close: async () => {
      try {
        await call('close', []);
      } finally {
        fail(new StorageUnavailableError('Local storage is closed.'));
        options.onClose?.();
      }
    },
  };
}

function revive(error: { name: string; message: string }): Error {
  if (error.name === 'StorageFencedError') return new StorageFencedError();
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}
