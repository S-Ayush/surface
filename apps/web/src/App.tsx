// The app: auth and the router (PLAN-005 S4), inside the overlay, shortcut and command-menu
// providers. The command menu sits above the router so pages can set its target; it reaches
// navigation and the store through the AppModel.
import { OverlayProvider } from '@surface/ui';
import { RouterProvider } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import type { AppModel } from './app/AppModel.js';
import { AppContext, useObserved } from './app/context.js';
import { createAppRouter, followAuth } from './app/router.js';
import { CommandMenuProvider } from './command-menu/CommandMenuProvider.js';
import { ShortcutHelp } from './shortcuts/ShortcutHelp.js';
import { ShortcutProvider, useCommand } from './shortcuts/ShortcutProvider.js';
import { browserThemeEnvironment, toggleTheme } from './theme/toggleTheme.js';

/** App-wide commands that need no page (the shell adds its own). */
function AppCommands() {
  useCommand('toggle:theme', () => {
    toggleTheme(browserThemeEnvironment());
  });
  return null;
}

export function App({ app }: { app: AppModel }) {
  const [router] = useState(() => createAppRouter(app));
  // Sign-in state changed (logout, a revoked session): run the guards again (SPEC-005 §3).
  useEffect(() => followAuth(app, router), [app, router]);
  const store = useObserved(
    useCallback(() => app.store, [app]),
    Object.is,
  );
  // Navigation commands only make sense in the shell: on /login and /setup they would bounce
  // straight back (SPEC-005 §4.1 hides them while `navigate` is absent).
  const signedIn = useObserved(useCallback(() => app.session !== null, [app]));
  const navigate = useCallback(
    (path: string) => {
      void router.navigate({ href: path });
    },
    [router],
  );
  const route = useCallback(() => router.state.location.pathname, [router]);

  return (
    <AppContext value={app}>
      <OverlayProvider>
        <ShortcutProvider>
          <CommandMenuProvider
            actor={app.actor}
            store={store}
            {...(signedIn ? { navigate } : {})}
            teams={app.teams}
            route={route}
          >
            <AppCommands />
            <RouterProvider router={router} />
            <ShortcutHelp />
          </CommandMenuProvider>
        </ShortcutProvider>
      </OverlayProvider>
    </AppContext>
  );
}
