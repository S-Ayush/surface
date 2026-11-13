// The PLAN-001 screens the router hosts (SPEC-001 §7): the router owns the URLs and guards,
// the features own the screens and register them in features/screens.ts. (/setup is PLAN-001
// S2's wizard, routes/setup, and /login is PLAN-001 S3's page, pages/LoginPage: the router
// renders both directly.)
import type { ComponentType } from 'react';

export type ScreenId =
  | 'login/check-email'
  | 'forgot'
  | 'reset'
  | 'invite'
  | 'login/magic'
  | 'settings/account/profile'
  | 'settings/account/security'
  | 'settings/account/preferences'
  | 'settings/members'
  | 'settings/workspace'
  | 'settings/teams'
  | 'settings/teams/general'
  | 'settings/teams/members'
  | 'settings/teams/workflow'
  | 'settings/teams/labels'
  | 'settings/labels'
  | 'settings/teams/estimates';

/** The route's path params (`token` for an invite, `key` for a team's settings). */
export type ScreenProps = { readonly params: Readonly<Record<string, string>> };

export type ScreenRegistry = Readonly<Partial<Record<ScreenId, ComponentType<ScreenProps>>>>;
