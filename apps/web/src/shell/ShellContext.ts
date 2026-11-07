// The shell's state for its pages (PageHeader's drawer button) and its own components.
import { createContext, use, useSyncExternalStore } from 'react';
import { DRAWER_QUERY, layoutMode, type LayoutMode } from './layout.js';
import type { ShellStore } from './ShellStore.js';

export const ShellContext = createContext<ShellStore | null>(null);

export function useShell(): ShellStore {
  const shell = use(ShellContext);
  if (shell === null) throw new Error('Render inside <Shell>');
  return shell;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DRAWER_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** `drawer` below 1024 px (AC-16), `full` otherwise; follows window resizes. */
export function useLayoutMode(): LayoutMode {
  const drawer = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DRAWER_QUERY).matches,
    () => layoutMode(Number.POSITIVE_INFINITY) === 'drawer',
  );
  return drawer ? 'drawer' : 'full';
}
