/**
 * The hooks against a real store, rendered on the server in Node (ADR-0017).
 * Re-rendering after a change is `observe`'s job, tested in sync-client
 * (`observe.test.ts`, `inspect.test.ts`); a browser test waits for the e2e hold.
 */
import { SyncStore } from '@surface/sync-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyncStoreProvider } from '../src/context.js';
import {
  useBootstrapProgress,
  useConnectionState,
  useInspector,
  usePendingCount,
  useStorageWarning,
} from '../src/hooks.js';

function newStore(): SyncStore {
  return new SyncStore({
    models: [],
    workspaceId: 'ws',
    userId: 'user-1',
    clientId: '0190f4c4-0000-7000-8000-00000000c11e',
    fetch: () => Promise.reject(new Error('not used: the store is never started')),
    locks: null,
    connection: { online: { subscribe: () => () => undefined } },
  });
}

/** Render `useHook` under a provider and return what it gave. */
function read<T>(useHook: () => T, store = newStore()): T {
  let value: { readonly v: T } | undefined;
  function Probe() {
    value = { v: useHook() };
    return null;
  }
  renderToStaticMarkup(
    <SyncStoreProvider store={store}>
      <Probe />
    </SyncStoreProvider>,
  );
  if (value === undefined) throw new Error('the probe did not render');
  return value.v;
}

describe('the hooks read the store they are given', () => {
  it('connection, pending count, start-up and storage warning of a store not started', () => {
    const store = newStore();
    expect(read(useConnectionState, store)).toEqual({
      state: 'disconnected',
      since: store.connectionSince,
      reconnectingSince: undefined,
      liveUpdatesUnavailable: false,
    });
    expect(read(usePendingCount, store)).toBe(0);
    expect(read(useBootstrapProgress, store)).toEqual({
      status: 'idle',
      progress: undefined,
      error: undefined,
    });
    expect(read(useStorageWarning, store)).toBeUndefined();
    expect(read(useInspector, store)).toMatchObject({
      status: 'idle',
      clientId: store.clientId,
      lastSyncId: undefined,
      rows: [],
    });
  });

  it('say how to fix a missing provider', () => {
    function Bare() {
      usePendingCount();
      return null;
    }
    expect(() => renderToStaticMarkup(<Bare />)).toThrow(
      'The sync hooks need a store. Wrap the app in <SyncStoreProvider store={…}>.',
    );
  });
});
