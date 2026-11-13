// Where the properties panel sits (SPEC-012 §3.4, design-system §3): beside the text column from
// 1280 px, a drawer opened from the header below that (the sidebar itself is a drawer below 1024).
import { useSyncExternalStore } from 'react';

export const PANEL_INLINE_FROM = 1280;

export type PanelMode = 'inline' | 'drawer';

export function panelMode(width: number): PanelMode {
  return width >= PANEL_INLINE_FROM ? 'inline' : 'drawer';
}

const QUERY = `(max-width: ${PANEL_INLINE_FROM - 0.02}px)`;

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** `inline` from 1280 px, `drawer` below; follows window resizes. */
export function usePanelMode(): PanelMode {
  const drawer = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
  return drawer ? 'drawer' : 'inline';
}
