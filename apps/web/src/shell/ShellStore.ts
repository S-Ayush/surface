// Shell state (SPEC-005 §6): sidebar width, collapsed, the drawer, and which team sections are
// expanded. Width, collapse and sections persist per device in localStorage; the drawer is
// per page view. The focus/selection context lives in command-menu/context.ts (TargetStore).
import { action, makeObservable, observable } from 'mobx';
import { z } from 'zod';
import { RESIZE_STEP, SIDEBAR_DEFAULT, clampSidebar, type LayoutMode } from './layout.js';

export const SHELL_STORAGE_KEY = 'surface.shell';

const STORED = z.object({
  width: z.number().optional(),
  collapsed: z.boolean().optional(),
  expanded: z.array(z.string()).max(500).optional(),
});

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export class ShellStore {
  width = SIDEBAR_DEFAULT;
  collapsed = false;
  /** Drawer mode only: the sidebar is open over the page. */
  drawerOpen = false;
  readonly expanded = observable.set<string>();
  /** The live region's text: the page title after a navigation (SPEC-005 §6). */
  announcement = '';
  #shownTitle: string | undefined;
  readonly #storage: StorageLike | null;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    const stored = this.#read();
    if (stored.width !== undefined) this.width = clampSidebar(stored.width);
    if (stored.collapsed !== undefined) this.collapsed = stored.collapsed;
    for (const id of stored.expanded ?? []) this.expanded.add(id);
    makeObservable(this, {
      width: observable,
      collapsed: observable,
      drawerOpen: observable,
      announcement: observable,
      setWidth: action,
      previewWidth: action,
      resizeBy: action,
      toggleSidebar: action,
      closeDrawer: action,
      toggleTeam: action,
      showTitle: action,
    });
  }

  /** Whether the sidebar shows: in full mode unless collapsed; in drawer mode while open. */
  sidebarVisible(mode: LayoutMode): boolean {
    return mode === 'drawer' ? this.drawerOpen : !this.collapsed;
  }

  setWidth(width: number): void {
    this.previewWidth(width);
    this.commitWidth();
  }

  /** While dragging: follow the pointer without writing storage on every move. */
  previewWidth(width: number): void {
    this.width = clampSidebar(width);
  }

  /** The drag ended: keep the width for the next visit. */
  commitWidth(): void {
    this.#save();
  }

  /** Keyboard resizing on the handle: arrow keys, five steps with Shift. */
  resizeBy(steps: number): void {
    this.setWidth(this.width + steps * RESIZE_STEP);
  }

  /** `[` (shortcuts.md §3.1): collapse or expand; in drawer mode, open or close the drawer. */
  toggleSidebar(mode: LayoutMode): void {
    if (mode === 'drawer') {
      this.drawerOpen = !this.drawerOpen;
      return;
    }
    this.collapsed = !this.collapsed;
    this.#save();
  }

  closeDrawer(): void {
    this.drawerOpen = false;
  }

  isExpanded(teamId: string): boolean {
    return this.expanded.has(teamId);
  }

  toggleTeam(teamId: string): void {
    if (this.expanded.has(teamId)) this.expanded.delete(teamId);
    else this.expanded.add(teamId);
    this.#save();
  }

  /**
   * A page set its title. Every title after the first is announced: pages commit after the
   * router's location changes, so the title, not the path, says the new page is there.
   */
  showTitle(title: string): void {
    if (this.#shownTitle !== undefined && title !== this.#shownTitle) this.announcement = title;
    this.#shownTitle = title;
  }

  #read(): z.infer<typeof STORED> {
    try {
      const raw = this.#storage?.getItem(SHELL_STORAGE_KEY);
      if (raw === null || raw === undefined) return {};
      const parsed = STORED.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      // Blocked storage or a corrupt value: start from the defaults.
      return {};
    }
  }

  #save(): void {
    try {
      this.#storage?.setItem(
        SHELL_STORAGE_KEY,
        JSON.stringify({
          width: this.width,
          collapsed: this.collapsed,
          expanded: [...this.expanded],
        }),
      );
    } catch {
      // Quota or privacy errors only lose the layout for the next visit.
    }
  }
}
