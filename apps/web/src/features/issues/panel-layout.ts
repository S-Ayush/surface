// Where the properties panel sits (SPEC-012 §3.4, §7.3, design-system §3): beside the text column
// from 1280 px; a drawer opened from the header from 768 to 1279 px (the sidebar itself is a
// drawer below 1024); and below 768 px, one column with the properties as a wrapping row of pills
// under the title, still editable.
import { useSyncExternalStore } from 'react';

export const PANEL_INLINE_FROM = 1280;
export const PANEL_STACKED_BELOW = 768;

export type PanelMode = 'inline' | 'drawer' | 'stacked';

export function panelMode(width: number): PanelMode {
  if (width >= PANEL_INLINE_FROM) return 'inline';
  return width < PANEL_STACKED_BELOW ? 'stacked' : 'drawer';
}

const DRAWER_QUERY = `(max-width: ${PANEL_INLINE_FROM - 0.02}px)`;
const STACKED_QUERY = `(max-width: ${PANEL_STACKED_BELOW - 0.02}px)`;

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(DRAWER_QUERY), window.matchMedia(STACKED_QUERY)];
  for (const query of queries) query.addEventListener('change', onChange);
  return () => {
    for (const query of queries) query.removeEventListener('change', onChange);
  };
}

function current(): PanelMode {
  if (window.matchMedia(STACKED_QUERY).matches) return 'stacked';
  return window.matchMedia(DRAWER_QUERY).matches ? 'drawer' : 'inline';
}

/** `inline` from 1280 px, `drawer` below, `stacked` below 768 px; follows window resizes. */
export function usePanelMode(): PanelMode {
  return useSyncExternalStore(subscribe, current, () => 'inline');
}
