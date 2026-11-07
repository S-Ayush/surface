// The route tree (SPEC-005 §3, SPEC-001 §7), code-based (ADR-0004). Public pages render without
// the shell; everything else sits under the pathless `shell` route, whose guard needs a session.
// The guards themselves are app/guards.ts; they run in `beforeLoad` once auth has loaded, and
// again whenever the session changes (followAuth, started by App.tsx).
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useLocation,
  useNavigate,
  useParams,
  type ParsedLocation,
  type RouterHistory,
} from '@tanstack/react-router';
import { reaction } from 'mobx';
import { useCallback, useEffect } from 'react';
import { MyIssuesPage } from '../pages/MyIssuesPage.js';
import { NotFoundPage, StandaloneNotFoundPage } from '../pages/NotFoundPage.js';
import { LoginPage } from '../pages/LoginPage.js';
import { PublicPage } from '../pages/PublicPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { TeamHomePage } from '../pages/TeamHomePage.js';
import { SetupPage } from '../routes/setup/SetupPage.js';
import { usePageTitle } from '../shell/usePageTitle.js';
import type { AppModel } from './AppModel.js';
import { AppErrorPage } from './AppErrorPage.js';
import { useApp, useObserved } from './context.js';
import { guard, type Access } from './guards.js';
import type { ScreenId } from './screens.js';
import { SETTINGS, type SettingsSection } from './settings.js';
import { ShellRoute } from './ShellRoute.js';

export type RouterContext = { readonly app: AppModel };

/** Auth could not be loaded; the root error page says so (AppErrorPage). */
export class AuthUnavailableError extends Error {}

function guarded(access: Access) {
  return async ({ context, location }: { context: RouterContext; location: ParsedLocation }) => {
    const snapshot = await context.app.auth.ready();
    if (snapshot.status !== 'ready') throw new AuthUnavailableError(snapshot.status);
    const result = guard(
      access,
      // The raw query value: `next` is checked by safeNext, not by the router's JSON parsing.
      { path: location.href, next: new URLSearchParams(location.searchStr).get('next') },
      {
        setupComplete: snapshot.capabilities.setupComplete,
        signedIn: snapshot.session !== null,
        loggedOut: snapshot.loggedOut === true,
      },
    );
    // A relative href stays in the app (only a URL with a scheme reloads the document). Admin
    // pages decide in the page, as the role comes from the store (SettingsPage).
    if (result.kind === 'redirect') redirect({ href: result.to, replace: true, throw: true });
  };
}

/**
 * Runs the guards again whenever the session changes after auth has loaded: a logout, or a
 * session the server revoked (SPEC-002 E10), sends the user to /login. Returns the disposer.
 */
export function followAuth(app: AppModel, router: { invalidate(): Promise<void> }): () => void {
  return reaction(
    () => app.auth.snapshot,
    (_next, previous) => {
      // The first load (loading → ready) is the router's own initial load.
      if (previous.status === 'ready') void router.invalidate();
    },
  );
}

const redirectTo = (href: string) => () => {
  redirect({ href, replace: true, throw: true });
};

/** The current route's path params as strings (`token`, `key`). */
function useRouteParams(): Record<string, string> {
  const params: Record<string, unknown> = useParams({ strict: false });
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: StandaloneNotFoundPage,
  errorComponent: AppErrorPage,
});

// Public pages (SPEC-001 §7): no shell. Paths stay literal in each createRoute, so links are
// type-checked against the tree.
function publicScreen(screen: ScreenId, title: string) {
  return function Public() {
    return <PublicPage screen={screen} title={title} params={useRouteParams()} />;
  };
}

const publicRoutes = [
  // PLAN-001 S2's wizard, which has its own page layout.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup',
    beforeLoad: guarded('setup'),
    component: function Setup() {
      usePageTitle('Set up Surface');
      const search = useLocation({ select: (location) => location.searchStr });
      return <SetupPage token={new URLSearchParams(search).get('token')} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    beforeLoad: guarded('public'),
    component: LoginPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/check-email',
    beforeLoad: guarded('public'),
    component: publicScreen('login/check-email', 'Check your email'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/forgot',
    beforeLoad: guarded('public'),
    component: publicScreen('forgot', 'Reset your password'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/reset',
    beforeLoad: guarded('public'),
    component: publicScreen('reset', 'Choose a new password'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite/$token',
    beforeLoad: guarded('public'),
    component: publicScreen('invite', 'Join the workspace'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/auth/magic',
    beforeLoad: guarded('public'),
    component: publicScreen('auth/magic', 'Logging in'),
  }),
];

// The shell (SPEC-005 §2): signed in; the store opens inside it.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  beforeLoad: guarded('signed-in'),
  component: ShellRoute,
  notFoundComponent: NotFoundPage,
});

// `/` → the user's home view (SPEC-005 §3): a team, or My issues. It is known once the replica
// is ready; until then the shell shows its progress and `HomeRedirect` waits. Waiting in
// `beforeLoad` instead would hold back the shell that opens the store.
const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    const home = context.app.home();
    if (home !== undefined) redirect({ href: home, replace: true, throw: true });
  },
  component: HomeRedirect,
});

function HomeRedirect() {
  const app = useApp();
  const navigate = useNavigate();
  const home = useObserved(useCallback(() => app.home(), [app]));
  useEffect(() => {
    if (home !== undefined) void navigate({ href: home, replace: true });
  }, [home, navigate]);
  return null;
}

const myIssuesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'my-issues',
  component: MyIssuesPage,
});

const teamRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'team/$key',
  component: function TeamHome() {
    return <TeamHomePage teamKey={useRouteParams().key ?? ''} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings',
  notFoundComponent: NotFoundPage,
});

function settingsScreen(section: SettingsSection) {
  return function Settings() {
    return <SettingsPage section={section} params={useRouteParams()} />;
  };
}

const accountRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'account' });
const teamsRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'teams' });

const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  shellRoute.addChildren([
    homeRoute,
    myIssuesRoute,
    teamRoute,
    settingsRoute.addChildren([
      createRoute({
        getParentRoute: () => settingsRoute,
        path: '/',
        beforeLoad: redirectTo('/settings/account/profile'),
      }),
      accountRoute.addChildren([
        createRoute({
          getParentRoute: () => accountRoute,
          path: '/',
          beforeLoad: redirectTo('/settings/account/profile'),
        }),
        createRoute({
          getParentRoute: () => accountRoute,
          path: 'profile',
          component: settingsScreen(SETTINGS.profile),
        }),
        createRoute({
          getParentRoute: () => accountRoute,
          path: 'preferences',
          component: settingsScreen(SETTINGS.preferences),
        }),
        createRoute({
          getParentRoute: () => accountRoute,
          path: 'security',
          component: settingsScreen(SETTINGS.security),
        }),
      ]),
      createRoute({
        getParentRoute: () => settingsRoute,
        path: 'members',
        component: settingsScreen(SETTINGS.members),
      }),
      createRoute({
        getParentRoute: () => settingsRoute,
        path: 'workspace',
        component: settingsScreen(SETTINGS.workspace),
      }),
      teamsRoute.addChildren([
        createRoute({
          getParentRoute: () => teamsRoute,
          path: '/',
          component: settingsScreen(SETTINGS.teams),
        }),
        createRoute({
          getParentRoute: () => teamsRoute,
          path: '$key/general',
          component: settingsScreen(SETTINGS.teamGeneral),
        }),
        createRoute({
          getParentRoute: () => teamsRoute,
          path: '$key/members',
          component: settingsScreen(SETTINGS.teamMembers),
        }),
      ]),
    ]),
  ]),
]);

/** Outside a browser (tests): a memory history, an origin, `isServer: false`, no scrolling. */
export type RouterEnvironment = {
  readonly history?: RouterHistory;
  readonly origin?: string;
  readonly isServer?: boolean;
  readonly scrollRestoration?: boolean;
};

export function createAppRouter(app: AppModel, options: RouterEnvironment = {}) {
  return createRouter({ routeTree, context: { app }, scrollRestoration: true, ...options });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
