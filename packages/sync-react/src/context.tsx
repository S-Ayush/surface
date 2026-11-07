import type { SyncStore } from '@surface/sync-client';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

const StoreContext = createContext<SyncStore | null>(null);

/** Makes `store` available to the sync hooks and the inspector below it. */
export function SyncStoreProvider({
  store,
  children,
}: {
  readonly store: SyncStore;
  readonly children?: ReactNode;
}) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

/** The store from the nearest `SyncStoreProvider`. */
export function useSyncStore(): SyncStore {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error('The sync hooks need a store. Wrap the app in <SyncStoreProvider store={…}>.');
  }
  return store;
}
