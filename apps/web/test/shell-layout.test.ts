// SPEC-005 AC-16 (unit part; the 375 px e2e is held) and §6 shell state: the sidebar is a drawer
// below 1024 px; width, collapse and expanded sections persist per device.
import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebar,
  DRAWER_QUERY,
  layoutMode,
} from '../src/shell/layout.js';
import { SHELL_STORAGE_KEY, ShellStore } from '../src/shell/ShellStore.js';

function memory(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SHELL_STORAGE_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('AC-16: layout mode', () => {
  it('is a drawer on phones and tablets, full from 1024 px', () => {
    expect(layoutMode(375)).toBe('drawer');
    expect(layoutMode(1023)).toBe('drawer');
    expect(layoutMode(1024)).toBe('full');
    expect(layoutMode(1440)).toBe('full');
  });

  it('switches at the same width in the browser (the media query) as in layoutMode', () => {
    // The browser decides through matchMedia(DRAWER_QUERY): read the query as a browser would.
    const match = /^\(max-width: (\d+(?:\.\d+)?)px\)$/.exec(DRAWER_QUERY);
    expect(match).not.toBeNull();
    const max = Number(match?.[1]);
    for (const width of [375, 767, 768, 1023, 1023.5, 1024, 1025, 1440]) {
      expect(width <= max ? 'drawer' : 'full').toBe(layoutMode(width));
    }
  });
});

describe('shell store', () => {
  it('clamps the sidebar width to the token range', () => {
    expect(clampSidebar(100)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(999)).toBe(SIDEBAR_MAX);
    expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    const shell = new ShellStore(null);
    shell.resizeBy(-100);
    expect(shell.width).toBe(SIDEBAR_MIN);
  });

  it('[ collapses the sidebar in full mode and opens the drawer in drawer mode', () => {
    const shell = new ShellStore(null);
    expect(shell.sidebarVisible('full')).toBe(true);
    expect(shell.sidebarVisible('drawer')).toBe(false);
    shell.toggleSidebar('drawer');
    expect(shell.sidebarVisible('drawer')).toBe(true);
    expect(shell.collapsed).toBe(false); // the drawer does not change the desktop layout
    shell.toggleSidebar('full');
    expect(shell.sidebarVisible('full')).toBe(false);
  });

  it('remembers width, collapse and expanded teams on this device, but not the drawer', () => {
    const storage = memory();
    const shell = new ShellStore(storage);
    shell.setWidth(300);
    shell.toggleSidebar('full');
    shell.toggleTeam('team-eng');
    shell.toggleSidebar('drawer');
    const again = new ShellStore(storage);
    expect(again.width).toBe(300);
    expect(again.collapsed).toBe(true);
    expect(again.isExpanded('team-eng')).toBe(true);
    expect(again.drawerOpen).toBe(false);
    again.toggleTeam('team-eng');
    expect(new ShellStore(storage).isExpanded('team-eng')).toBe(false);
  });

  it('ignores unreadable or out-of-range stored values', () => {
    expect(new ShellStore(memory('not json')).width).toBe(SIDEBAR_DEFAULT);
    expect(new ShellStore(memory('{"width":"wide"}')).width).toBe(SIDEBAR_DEFAULT);
    expect(new ShellStore(memory('{"width":5000}')).width).toBe(SIDEBAR_MAX);
  });

  it('saves a dragged width once, when the drag ends', () => {
    const storage = memory();
    const shell = new ShellStore(storage);
    shell.previewWidth(250);
    shell.previewWidth(5000);
    expect(shell.width).toBe(SIDEBAR_MAX);
    expect(storage.data.has(SHELL_STORAGE_KEY)).toBe(false);
    shell.commitWidth();
    expect(new ShellStore(storage).width).toBe(SIDEBAR_MAX);
  });

  it('announces each new page title after the first (SPEC-005 §6)', () => {
    const shell = new ShellStore(null);
    shell.showTitle('My issues · Surface');
    expect(shell.announcement).toBe('');
    shell.showTitle('Engineering · Surface');
    expect(shell.announcement).toBe('Engineering · Surface');
    shell.showTitle('Engineering · Surface');
    expect(shell.announcement).toBe('Engineering · Surface');
    shell.showTitle('My issues · Surface');
    expect(shell.announcement).toBe('My issues · Surface');
  });
});
