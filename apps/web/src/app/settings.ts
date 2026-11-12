// The settings sections (SPEC-001 §7): one table read by the router (which page each route
// shows) and by the settings nav, so the admin flag lives in one place. Admin-only sections are
// left out of a Member's nav and their URLs show not-found (SPEC-005 §3, permissions.md §5).
import type { ScreenId } from './screens.js';

export type SettingsSection = {
  readonly screen: ScreenId;
  /** Breadcrumb, page title, nav label and placeholder. */
  readonly title: string;
  readonly admin: boolean;
  /** The nav link, for sections listed in the nav. */
  readonly nav?: string;
};

export const SETTINGS = {
  profile: {
    screen: 'settings/account/profile',
    title: 'Profile',
    admin: false,
    nav: '/settings/account/profile',
  },
  preferences: {
    screen: 'settings/account/preferences',
    title: 'Preferences',
    admin: false,
    nav: '/settings/account/preferences',
  },
  security: {
    screen: 'settings/account/security',
    title: 'Security',
    admin: false,
    nav: '/settings/account/security',
  },
  workspace: {
    screen: 'settings/workspace',
    title: 'Workspace',
    admin: true,
    nav: '/settings/workspace',
  },
  members: { screen: 'settings/members', title: 'Members', admin: true, nav: '/settings/members' },
  teams: { screen: 'settings/teams', title: 'Teams', admin: false, nav: '/settings/teams' },
  teamGeneral: { screen: 'settings/teams/general', title: 'Team settings', admin: false },
  teamMembers: { screen: 'settings/teams/members', title: 'Team members', admin: false },
  teamWorkflow: { screen: 'settings/teams/workflow', title: 'Workflow', admin: false },
} as const satisfies Record<string, SettingsSection>;

const NAV = [
  SETTINGS.profile,
  SETTINGS.preferences,
  SETTINGS.security,
  SETTINGS.workspace,
  SETTINGS.members,
  SETTINGS.teams,
];

/** The nav for this user: admin sections only once the role is known to be Admin. */
export function settingsNav(isAdmin: boolean | undefined): readonly (typeof NAV)[number][] {
  return NAV.filter((section) => !section.admin || isAdmin === true);
}
