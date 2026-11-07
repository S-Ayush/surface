// The PLAN-001 screens the router hosts (SPEC-001 §7): the router owns the URLs and guards,
// the features own the screens and register them in features/screens.ts. (/setup is PLAN-001
// S2's wizard, routes/setup, which the router renders directly.)
import type { ComponentType } from 'react';

export type ScreenId =
  | 'login'
  | 'login/check-email'
  | 'forgot'
  | 'reset'
  | 'invite'
  | 'auth/magic'
  | 'settings/account/profile'
  | 'settings/account/security'
  | 'settings/members'
  | 'settings/workspace'
  | 'settings/teams'
  | 'settings/teams/general'
  | 'settings/teams/members';

/** The route's path params (`token` for an invite, `key` for a team's settings). */
export type ScreenProps = { readonly params: Readonly<Record<string, string>> };

export type ScreenRegistry = Readonly<Partial<Record<ScreenId, ComponentType<ScreenProps>>>>;
