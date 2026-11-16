// The PLAN-001 screens (SPEC-001 §7) the router renders, by route (app/screens.ts lists the ids).
// A feature keeps its screens in its own folder and adds one line here per screen; a route with
// no screen shows a placeholder. Shared registry file, append-only for every session (sessions
// README §7): add your own lines only, and on a rebase conflict keep both sides.
import type { ScreenRegistry } from '../app/screens.js';
import { PreferencesScreen } from '../preferences/PreferencesScreen.js';
import {
  CheckEmailScreen,
  ForgotScreen,
  MagicLinkScreen,
  ResetScreen,
} from './account/AccountScreens.js';
import { EstimatesScreen } from './estimates/EstimatesScreen.js';
import { InviteScreen } from './invites/InviteScreen.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from './labels/LabelsScreen.js';
import { MembersScreen } from './members/MembersScreen.js';
import { WorkflowScreen } from './statuses/WorkflowScreen.js';
import { TeamAutomationsScreen } from './teams/TeamAutomationsScreen.js';
import { TeamGeneralScreen } from './teams/TeamGeneralScreen.js';
import { TeamMembersScreen } from './teams/TeamMembersScreen.js';
import { TeamsScreen } from './teams/TeamsScreen.js';
import { WorkspaceScreen } from './workspace/WorkspaceScreen.js';
import { ProfileScreen } from './profile/ProfileScreen.js';
import { SecurityScreen } from './security/SecurityScreen.js';

export const SCREENS: ScreenRegistry = {
  'settings/account/preferences': PreferencesScreen,
  'settings/teams': TeamsScreen,
  'settings/teams/general': TeamGeneralScreen,
  'settings/teams/members': TeamMembersScreen,
  'login/check-email': CheckEmailScreen,
  forgot: ForgotScreen,
  reset: ResetScreen,
  'login/magic': MagicLinkScreen,
  'settings/members': MembersScreen,
  'settings/workspace': WorkspaceScreen,
  invite: InviteScreen,
  'settings/account/profile': ProfileScreen,
  'settings/account/security': SecurityScreen,
  'settings/teams/workflow': WorkflowScreen,
  'settings/teams/labels': TeamLabelsScreen,
  'settings/labels': WorkspaceLabelsScreen,
  'settings/teams/estimates': EstimatesScreen,
  'settings/teams/automations': TeamAutomationsScreen,
};
