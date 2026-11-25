// The settings sidebar (PLAN-016 S7, design-system §3): replaces the app sidebar on /settings/*,
// with "Back to app" at the top and the settings sections under Account and Workspace headings.
import { Link, useRouter } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { settingsNav } from '../app/settings.js';
import { useShell } from './ShellContext.js';
import styles from './Shell.module.css';

export const SETTINGS_PATH = '/settings';

/** Whether the path is a settings page (and so shows the settings sidebar). */
export function inSettings(pathname: string): boolean {
  return pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`);
}

const GROUPS = ['Account', 'Workspace'] as const;

export function SettingsSidebar({ width, autoFocus }: { width: number; autoFocus: boolean }) {
  const app = useApp();
  const shell = useShell();
  const router = useRouter();
  const isAdmin = useObserved(useCallback(() => app.isAdmin(), [app]));
  const items = settingsNav(isAdmin);
  // The drawer opens with focus inside it, on the first link (as in Sidebar).
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [autoFocus]);
  return (
    <nav
      id="sidebar"
      ref={ref}
      aria-label="Settings"
      className={styles.sidebar}
      style={{ width }}
      onClickCapture={(event) => {
        // Following a link closes the drawer (as in Sidebar).
        if (!shell.drawerOpen) return;
        if (!(event.target instanceof Element) || event.target.closest('a') === null) return;
        document.getElementById('main')?.focus({ preventScroll: true });
        shell.closeDrawer();
      }}
    >
      <ul className={styles.nav}>
        <li>
          <a
            href={shell.lastAppPath}
            className={styles.item}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              router.history.push(shell.lastAppPath);
            }}
          >
            <ArrowLeft aria-hidden="true" />
            Back to app
          </a>
        </li>
      </ul>
      {GROUPS.map((group) => {
        const section = items.filter((item) => item.group === group);
        const headingId = `settings-nav-${group.toLowerCase()}`;
        return (
          <div key={group}>
            <h2 className={styles.section} id={headingId}>
              {group}
            </h2>
            <ul className={styles.nav} aria-labelledby={headingId}>
              {section.map((item) => (
                <li key={item.nav}>
                  <Link to={item.nav} className={styles.item}>
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
