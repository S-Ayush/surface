/**
 * Storage that fails without throwing must not hang start-up (review #3,
 * SPEC-002 E6): a worker that never loads, stops answering, or errors, and an
 * IndexedDB upgrade blocked by another tab.
 */
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { connectWithFallback, openStorage } from '../src/storage/open.js';
import type { MessagePortLike } from '../src/storage/rpc.js';
import {
  CALL_TIMEOUT_MS,
  OPEN_TIMEOUT_MS,
  StorageUnavailableError,
  connectStorage,
} from '../src/storage/rpc.js';
import { uniqueName } from './support/storage.js';

type Listener = (event: MessageEvent) => void;

/** A port whose far side answers with `respond`, or stays silent when it returns undefined. */
function fakePort(respond: (request: { id: number; method: string }) => unknown) {
  const listeners = new Map<string, Listener[]>();
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  };
  const port: MessagePortLike = {
    postMessage(message) {
      const request = message as { id: number; method: string };
      const value = respond(request);
      if (value !== undefined) {
        queueMicrotask(() => emit('message', { id: request.id, ok: true, value }));
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return { port, emit };
}

const MODELS = ['DebugItem'];

afterEach(() => {
  vi.useRealTimers();
});

describe('storage worker failures', () => {
  it('gives up on a worker that never answers open, so start-up falls back to memory', async () => {
    vi.useFakeTimers();
    const { port } = fakePort(() => undefined);
    const opening = openStorage('db', MODELS, (name, models) => connectStorage(port, name, models));
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    const { storage, fallbackReason } = await opening;
    expect(storage.kind).toBe('memory');
    expect(fallbackReason).toMatch(/did not start/);
  });

  it('fails every call, now and later, once the worker stops answering', async () => {
    vi.useFakeTimers();
    const { port } = fakePort((request) => (request.method === 'open' ? 'indexeddb' : undefined));
    const storage = await connectStorage(port, 'db', MODELS);
    const first = storage.readMeta();
    const second = storage.clear();
    const settled = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await expect(first).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(storage.readMeta()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('fails pending calls as soon as the worker reports an error (e.g. its script did not load)', async () => {
    const { port, emit } = fakePort((request) =>
      request.method === 'open' ? 'indexeddb' : undefined,
    );
    const storage = await connectStorage(port, 'db', MODELS);
    const pending = storage.readMeta();
    emit('error');
    await expect(pending).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('runs the close hook (terminating the worker) and refuses calls afterwards', async () => {
    const onClose = vi.fn();
    const { port } = fakePort((request) => (request.method === 'open' ? 'indexeddb' : 'closed'));
    const storage = await connectStorage(port, 'db', MODELS, { onClose });
    await storage.close();
    expect(onClose).toHaveBeenCalledOnce();
    await expect(storage.readMeta()).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

describe('IndexedDB upgrade blocked by another tab', () => {
  it('rejects instead of waiting for the other tab forever', async () => {
    const name = uniqueName();
    const first = await IndexedDbStorage.open(name, MODELS);
    await first.close();
    // An old tab that ignores version changes keeps the database open.
    const stubborn = await openDB(name);
    await expect(IndexedDbStorage.open(name, [...MODELS, 'Card'])).rejects.toThrow(
      /Close other Surface tabs/,
    );
    stubborn.close();
  });
});

describe('a worker that cannot run', () => {
  it('falls back to IndexedDB on this thread when the worker fails (e.g. a CSP without worker-src)', async () => {
    const { port, emit } = fakePort(() => undefined);
    const terminate = vi.fn();
    const opening = connectWithFallback(uniqueName(), MODELS, () => ({ ...port, terminate }));
    emit('error');
    const storage = await opening;
    expect(storage.kind).toBe('indexeddb');
    expect(terminate).toHaveBeenCalledOnce();
    await storage.close();
  });

  it('falls back to IndexedDB on this thread when the worker cannot even be created', async () => {
    const storage = await connectWithFallback(uniqueName(), MODELS, () => {
      throw new Error('Refused to create a worker');
    });
    expect(storage.kind).toBe('indexeddb');
    await storage.close();
  });
});
