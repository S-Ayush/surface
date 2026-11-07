// The app shell (SPEC-005 §2, §6): skip link, the sidebar (resizable, `[` to collapse, a drawer
// below 1024 px), and `<main tabindex=-1>`, which takes focus after each navigation while the
// new page title is announced.
import { BannerRegion, VisuallyHidden } from '@surface/ui';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useObserved } from '../app/context.js';
import { SHELL_HOSTS } from '../features/hosts.js';
import { useCommand } from '../shortcuts/ShortcutProvider.js';
import { SIDEBAR_MAX, SIDEBAR_MIN } from './layout.js';
import { ShellContext, useLayoutMode } from './ShellContext.js';
import { ShellStore } from './ShellStore.js';
import { Sidebar } from './Sidebar.js';
import styles from './Shell.module.css';

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * `docked`: fixed-position tools that aren't page content (the sync inspector), kept outside
 * `<main>` so they are not part of its landmark or of the focus moved there after navigation.
 */
export function Shell({ children, docked }: { children: ReactNode; docked?: ReactNode }) {
  const [shell] = useState(() => new ShellStore(localStorageOrNull()));
  const mode = useLayoutMode();
  const navigate = useNavigate();
  const { width, visible, drawerOpen, announcement } = useObserved(
    useCallback(
      () => ({
        width: shell.width,
        visible: shell.sidebarVisible(mode),
        drawerOpen: shell.drawerOpen,
        announcement: shell.announcement,
      }),
      [shell, mode],
    ),
  );

  useCommand('toggle:sidebar', () => {
    shell.toggleSidebar(mode);
  });
  useCommand('nav:settings', () => {
    void navigate({ to: '/settings' });
  });
  // Esc closes the open drawer (page level: it wins over the app's Esc while the drawer is open).
  useCommand('ui:escape', () => shell.closeDrawer(), {
    when: () => mode === 'drawer' && shell.drawerOpen,
    level: 'page',
  });

  // After a navigation: close the drawer and focus <main> (§6). Not on the first render. The new
  // title is announced when the page sets it (usePageTitle → ShellStore.showTitle).
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    shell.closeDrawer();
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname, shell]);

  // The sidebar appeared or went without a navigation (the header button, `[`, Esc, the
  // backdrop). If focus went with the control that was removed (the "Show sidebar" button, the
  // resize handle, a link in the drawer), put it in the sidebar when it appears, or on the
  // header's sidebar button when it goes.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const changed = wasVisible.current !== visible;
    wasVisible.current = visible;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!changed || !lost) return;
    const target = visible
      ? document.getElementById('sidebar')?.querySelector<HTMLElement>('a, button')
      : document.querySelector<HTMLElement>('header [aria-controls="sidebar"]');
    target?.focus();
  }, [visible]);

  // A drawer left open must not reappear (and take focus) on the next resize below 1024 px.
  useEffect(() => {
    if (mode === 'full') shell.closeDrawer();
  }, [mode, shell]);

  return (
    <ShellContext value={shell}>
      <div className={styles.shell} data-mode={mode}>
        <a
          href="#main"
          className={styles.skip}
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
        >
          Skip to content
        </a>
        {visible && (
          <>
            {mode === 'drawer' && (
              <div
                className={styles.backdrop}
                aria-hidden="true"
                onClick={() => {
                  shell.closeDrawer();
                }}
              />
            )}
            <Sidebar width={width} autoFocus={mode === 'drawer' && drawerOpen} />
            {mode === 'full' && <ResizeHandle shell={shell} width={width} />}
          </>
        )}
        <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
          {/* System banners across the top of the page (design-system §5.1, SPEC-005 §8). */}
          <BannerRegion />
          {children}
        </main>
        {docked}
        <VisuallyHidden>
          <p role="status">{announcement}</p>
        </VisuallyHidden>
        <FeatureHosts hosts={SHELL_HOSTS} />
      </div>
    </ShellContext>
  );
}

/** Features' dialogs and commands, mounted once for the life of the shell (features/hosts.ts). */
export function FeatureHosts({ hosts }: { hosts: readonly ComponentType[] }) {
  // The list is a module constant, so a host's index is a stable key.
  return hosts.map((Host, index) => <Host key={index} />);
}

/** The sidebar's right edge: drag, or focus it and use the arrow keys (Shift for bigger steps). */
function ResizeHandle({ shell, width }: { shell: ShellStore; width: number }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const endDrag = () => {
    if (drag.current === null) return;
    drag.current = null;
    shell.commitWidth();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls="sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className={styles.resize}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start !== null) shell.previewWidth(start.width + event.clientX - start.x);
      }}
      onPointerUp={endDrag}
      // A cancelled drag (a touch gesture, the system taking the pointer) ends it too, or the
      // next hover would go on resizing.
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        const steps = event.shiftKey ? 5 : 1;
        if (event.key === 'ArrowLeft') shell.resizeBy(-steps);
        else if (event.key === 'ArrowRight') shell.resizeBy(steps);
        else if (event.key === 'Home') shell.setWidth(SIDEBAR_MIN);
        else if (event.key === 'End') shell.setWidth(SIDEBAR_MAX);
        else return;
        event.preventDefault();
      }}
    />
  );
}
