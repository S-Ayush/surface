// Shell layout rules (design-system §4 breakpoints, SPEC-005 E6). Widths are the component tokens
// `--sidebar-min-width` / `--sidebar-width` / `--sidebar-max-width`, in px for the resize maths.

/** Below this the sidebar overlays the page as a drawer (design-system: 768–1023 "sidebar overlays"). */
export const DRAWER_BELOW = 1024;
/** Below this the command menu is full width and pages are a single column (E6). */
export const NARROW_BELOW = 768;

export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 240;
export const SIDEBAR_MAX = 360;
/** One arrow-key step on the resize handle; Shift+arrow moves five. */
export const RESIZE_STEP = 8;

export type LayoutMode = 'full' | 'drawer';

export const layoutMode = (viewportWidth: number): LayoutMode =>
  viewportWidth < DRAWER_BELOW ? 'drawer' : 'full';

export const clampSidebar = (width: number): number =>
  Number.isFinite(width)
    ? Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
    : SIDEBAR_DEFAULT;

/** The media query matching drawer mode, for `matchMedia`. */
export const DRAWER_QUERY = `(max-width: ${DRAWER_BELOW - 0.02}px)`;
