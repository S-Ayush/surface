// The sidebar (SPEC-005 §7, M0): workspace and avatar menu, search, My issues, the user's teams
// (live, expandable to their pages) with "Browse teams", and Settings.
import { Kbd } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleDot, House, Search, Settings, Users } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import { AvatarMenu } from './AvatarMenu.js';
import { useShell } from './ShellContext.js';
import styles from './Shell.module.css';

export function Sidebar({ width, autoFocus }: { width: number; autoFocus: boolean }) {
  const app = useApp();
  const shell = useShell();
  const commands = useCommandRegistry();
  const { workspace, teams, expanded } = useObserved(
    useCallback(() => {
      const teams = app.teams();
      return {
        workspace: app.workspaceName(),
        teams,
        expanded: teams.filter((team) => shell.isExpanded(team.id)).map((team) => team.id),
      };
    }, [app, shell]),
  );
  // The drawer opens with focus inside it, on the first link.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [autoFocus]);

  return (
    <nav
      id="sidebar"
      ref={ref}
      aria-label="Sidebar"
      className={styles.sidebar}
      style={{ width }}
      // Following a link closes the drawer, even to the page already open (no navigation then,
      // so the shell's focus move doesn't run): focus goes to <main> first, as after navigating.
      onClickCapture={(event) => {
        if (!shell.drawerOpen) return;
        if (!(event.target instanceof Element) || event.target.closest('a') === null) return;
        document.getElementById('main')?.focus({ preventScroll: true });
        shell.closeDrawer();
      }}
    >
      <div className={styles.workspace}>
        <span className={styles.workspaceName}>{workspace}</span>
        <AvatarMenu />
      </div>
      <button
        type="button"
        className={styles.search}
        onClick={() => {
          commands.run('ui:command-menu');
        }}
      >
        <Search aria-hidden="true" />
        <span>Search</span>
        <Kbd keys="Mod+K" aria-hidden="true" />
      </button>
      <ul className={styles.nav}>
        <li>
          <Link to="/my-issues" className={styles.item}>
            <CircleDot aria-hidden="true" />
            My issues
          </Link>
        </li>
      </ul>
      <h2 className={styles.section} id="sidebar-teams">
        Your teams
      </h2>
      <ul className={styles.nav} aria-labelledby="sidebar-teams">
        {teams.map((team) => {
          const open = expanded.includes(team.id);
          const pagesId = `sidebar-team-${team.id}`;
          return (
            <li key={team.id}>
              <div className={styles.team}>
                <button
                  type="button"
                  className={styles.disclosure}
                  aria-expanded={open}
                  aria-controls={pagesId}
                  aria-label={`${team.name} pages`}
                  onClick={() => {
                    shell.toggleTeam(team.id);
                  }}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
                <Link to="/team/$key" params={{ key: team.key }} className={styles.item}>
                  <span className={styles.key}>{team.key}</span>
                  {team.name}
                </Link>
              </div>
              {open && (
                <ul id={pagesId} className={styles.pages}>
                  <li>
                    <Link
                      to="/team/$key"
                      params={{ key: team.key }}
                      className={styles.item}
                      aria-label={`${team.name} home`}
                    >
                      <House aria-hidden="true" />
                      Home
                    </Link>
                  </li>
                </ul>
              )}
            </li>
          );
        })}
        <li>
          <Link to="/settings/teams" className={styles.item}>
            <Users aria-hidden="true" />
            Browse teams
          </Link>
        </li>
      </ul>
      <ul className={`${styles.nav} ${styles.bottom}`}>
        <li>
          <Link to="/settings" className={styles.item}>
            <Settings aria-hidden="true" />
            Settings
          </Link>
        </li>
      </ul>
    </nav>
  );
}
