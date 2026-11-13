// Feature components the shell mounts (shared, append-only: docs/07-plans/sessions/README.md §7).
// A feature keeps its components in `features/<feature>/` and adds one line here, so the shell
// doesn't need to change for each feature.
import type { ComponentType } from 'react';
import { AnnouncerHost } from './issues/AnnouncerHost.js';
import { IssueNavHost } from './issues/IssueNavHost.js';
import { IssuesHost } from './issues/IssuesHost.js';
import { TeamMenu } from './teams/TeamMenu.js';
import { TeamsHost } from './teams/TeamsHost.js';

/** The team a team ⋯ menu acts on. */
export type TeamRef = { readonly id: string; readonly key: string; readonly name: string };

/**
 * Mounted once while the shell is open, on every page: dialogs and the commands that open them
 * (`useCommand`, e.g. `form:create-team`). They mount before the replica is ready, so a command
 * that needs the store says so in its `when`.
 */
export const SHELL_HOSTS: readonly ComponentType[] = [
  TeamsHost,
  AnnouncerHost,
  IssueNavHost,
  IssuesHost,
];

/**
 * The team ⋯ menu in the team page header (SPEC-001 §3.7: Join team / Leave team). One menu, so
 * not a list: the teams feature sets it (null until then).
 */
export const TEAM_MENU: ComponentType<{ readonly team: TeamRef }> | null = TeamMenu;
