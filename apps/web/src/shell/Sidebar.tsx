// The sidebar (SPEC-005 §7, M0): workspace and avatar menu, search, My issues, the user's teams
// (live, expandable to their pages) with "Browse teams", and Settings. PLAN-012 S5 adds Drafts and
// the New issue button. PLAN-015 S4 adds each team's Archive page (SPEC-015 §3.3; `G` `X`).
import { IconButton, Kbd } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import {
  Archive,
  ChevronRight,
  CircleDot,
  FilePen,
  House,
  Plus,
  Search,
  Settings,
  SquarePen,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import { AvatarMenu } from './AvatarMenu.js';
import { useShell } from './ShellContext.js';
import styles from './Shell.module.css';

export function Sidebar({ width, autoFocus }: { width: number; autoFocus: boolean }) {
  const app = useApp();
  const shell = useShell();
  const commands = useCommandRegistry();
  const { workspace, logo, online, teams, expanded } = useObserved(
    useCallback(() => {
      const teams = app.teams();
      return {
        workspace: app.workspaceName(),
        logo: app.workspaceLogoSrc(),
        online: app.online(),
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
        <span className={styles.workspaceTitle}>
          {/* A reconnect remounts it, so a logo that failed offline loads again. */}
          <WorkspaceLogo key={online ? 'online' : 'offline'} src={logo} />
          <span className={styles.workspaceName}>{workspace}</span>
        </span>
        <NewIssueButton />
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
        <li>
          <Link to="/drafts" className={styles.item}>
            <FilePen aria-hidden="true" />
            Drafts
          </Link>
        </li>
      </ul>
      <div className={styles.sectionRow}>
        <h2 className={styles.section} id="sidebar-teams">
          Your teams
        </h2>
        <CreateTeamButton />
      </div>
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
                      to="/team/$key/issues"
                      params={{ key: team.key }}
                      className={styles.item}
                      aria-label={`${team.name} issues`}
                    >
                      <CircleDot aria-hidden="true" />
                      Issues
                    </Link>
                  </li>
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
                  <li>
                    <Link
                      to="/team/$key/archive"
                      params={{ key: team.key }}
                      className={styles.item}
                      aria-label={`${team.name} archive`}
                    >
                      <Archive aria-hidden="true" />
                      Archive
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

/** **New issue** (SPEC-012 §3.1 item 1): opens the composer, like `C`. */
function NewIssueButton() {
  const commands = useCommandRegistry();
  const available = useObserved(
    useCallback(() => commands.isAvailable('issue:create'), [commands]),
  );
  if (!available) return null;
  return (
    <IconButton
      aria-label="New issue"
      size="sm"
      icon={<SquarePen />}
      onClick={() => {
        commands.run('issue:create');
      }}
    />
  );
}

/** The "+" next to Your teams (SPEC-001 §3.7): runs Create team, once a feature implements it. */
export function CreateTeamButton() {
  const commands = useCommandRegistry();
  const available = useObserved(
    useCallback(() => commands.isAvailable('form:create-team'), [commands]),
  );
  if (!available) return null;
  return (
    <IconButton
      aria-label="Create team"
      size="sm"
      icon={<Plus />}
      onClick={() => {
        commands.run('form:create-team');
      }}
    />
  );
}

/**
 * The logo before the workspace name (SPEC-005 §7), decorative since the name follows. Hidden when
 * it can't load (offline, where the worker doesn't keep /files/, or the server can't send it),
 * rather than a broken image.
 */
function WorkspaceLogo({ src }: { readonly src: string | undefined }) {
  const [failed, setFailed] = useState<string>();
  if (src === undefined || src === failed) return null;
  return (
    <img
      className={styles.workspaceLogo}
      src={src}
      alt=""
      onError={() => {
        setFailed(src);
      }}
    />
  );
}
