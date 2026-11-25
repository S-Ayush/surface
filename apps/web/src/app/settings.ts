// The settings sections (SPEC-001 §7): one table read by the router (which page each route
// shows) and by the settings nav, so the admin flag lives in one place. Admin-only sections are
// left out of a Member's nav and their URLs show not-found (SPEC-005 §3, permissions.md §5).
import type { ScreenId } from './screens.js';

export type SettingsSection = {
  readonly screen: ScreenId;
  /** Breadcrumb, page title, nav label and placeholder. */
  readonly title: string;
  /** One line under the page title (PLAN-016 S7). */
  readonly description: string;
  readonly admin: boolean;
  /** The nav link, for sections listed in the nav. */
  readonly nav?: string;
  /** The nav heading the link sits under. */
  readonly group?: 'Account' | 'Workspace';
};

export const SETTINGS = {
  profile: {
    screen: 'settings/account/profile',
    title: 'Profile',
    description: 'Your avatar, name and time zone.',
    admin: false,
    nav: '/settings/account/profile',
    group: 'Account',
  },
  preferences: {
    screen: 'settings/account/preferences',
    title: 'Preferences',
    description: 'Theme, font size and the page Surface opens on.',
    admin: false,
    nav: '/settings/account/preferences',
    group: 'Account',
  },
  security: {
    screen: 'settings/account/security',
    title: 'Security',
    description: 'Your password and the devices signed in to your account.',
    admin: false,
    nav: '/settings/account/security',
    group: 'Account',
  },
  workspace: {
    screen: 'settings/workspace',
    title: 'Workspace',
    description: 'The workspace name and logo.',
    admin: true,
    nav: '/settings/workspace',
    group: 'Workspace',
  },
  members: {
    screen: 'settings/members',
    title: 'Members',
    description: 'Invite people and manage their roles.',
    admin: true,
    nav: '/settings/members',
    group: 'Workspace',
  },
  teams: {
    screen: 'settings/teams',
    title: 'Teams',
    description: 'Browse teams, join one or manage the ones you lead.',
    admin: false,
    nav: '/settings/teams',
    group: 'Workspace',
  },
  teamGeneral: {
    screen: 'settings/teams/general',
    title: 'Team settings',
    description: 'The team’s name, key, icon, color and time zone.',
    admin: false,
  },
  teamMembers: {
    screen: 'settings/teams/members',
    title: 'Team members',
    description: 'Who belongs to the team.',
    admin: false,
  },
  teamWorkflow: {
    screen: 'settings/teams/workflow',
    title: 'Workflow',
    description: 'The statuses issues move through.',
    admin: false,
  },
  teamLabels: {
    screen: 'settings/teams/labels',
    title: 'Labels',
    description: 'Labels only this team uses.',
    admin: false,
  },
  teamEstimates: {
    screen: 'settings/teams/estimates',
    title: 'Estimates',
    description: 'How the team sizes issues.',
    admin: false,
  },
  teamAutomations: {
    screen: 'settings/teams/automations',
    title: 'Automations',
    description: 'What happens to issues without anyone doing it by hand.',
    admin: false,
  },
  // Every member, so outside the Admin-only Workspace page (SPEC-010 §7.1, D9).
  labels: {
    screen: 'settings/labels',
    title: 'Labels',
    description: 'Labels every team can use.',
    admin: false,
    nav: '/settings/labels',
    group: 'Workspace',
  },
} as const satisfies Record<string, SettingsSection>;

const NAV = [
  SETTINGS.profile,
  SETTINGS.preferences,
  SETTINGS.security,
  SETTINGS.workspace,
  SETTINGS.members,
  SETTINGS.labels,
  SETTINGS.teams,
];

/** The nav for this user: admin sections only once the role is known to be Admin. */
export function settingsNav(isAdmin: boolean | undefined): readonly (typeof NAV)[number][] {
  return NAV.filter((section) => !section.admin || isAdmin === true);
}
