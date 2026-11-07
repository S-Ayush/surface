// The AppModel for components, and a hook that re-renders when the observables it reads change.
import { createContext, use } from 'react';
import { useReactive } from '../command-menu/reactive.js';
import type { AppModel } from './AppModel.js';
import { structurallyEqual } from './equal.js';

export const AppContext = createContext<AppModel | null>(null);

export function useApp(): AppModel {
  const app = use(AppContext);
  if (app === null) throw new Error('Wrap the app in <AppContext value={app}>');
  return app;
}

/**
 * The value of `read`, kept current as the observables it reads change (a delta, sign-out).
 * Memoise `read` with useCallback. Values compare structurally, so a fresh but equal array
 * does not re-render; pass `Object.is` for objects like the store.
 */
export function useObserved<T>(
  read: () => T,
  equals: (a: T, b: T) => boolean = structurallyEqual,
): T {
  return useReactive(read, equals);
}
