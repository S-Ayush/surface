// AC-15 through the real route tree: the guards in beforeLoad, the redirects they produce, and
// re-running them when auth changes. A memory history stands in for the browser; nothing renders
// except the public pages, which need no shell.
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorPage } from '../src/app/AppErrorPage.js';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type AuthClient, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { createAppRouter, followAuth } from '../src/app/router.js';

const SESSION: Session = { userId: 'u1', workspaceId: 'w1' };

type Fake = Partial<AuthClient> & { signedInAs?: Session; setup?: boolean };

function client({ signedInAs, setup = true, ...rest }: Fake) {
  let current: Session | null = signedInAs ?? null;
  const auth: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: setup, smtp: false }),
    session: () => Promise.resolve(current),
    login: () => Promise.resolve({ ok: false, message: 'Not in this test' }),
    logout: () => {
      current = null;
      return Promise.resolve();
    },
    ...rest,
  };
  return auth;
}

const environment = (path: string) => ({
  history: createMemoryHistory({ initialEntries: [path] }),
  origin: 'http://localhost',
  isServer: false,
  scrollRestoration: false,
});

async function open(path: string, auth: AuthClient) {
  // The second look after a 4001 (AuthState.recheck) without a real wait.
  const app = new AppModel(new AuthState(auth, { wait: () => Promise.resolve() }));
  const router = createAppRouter(app, environment(path));
  await router.load();
  return { app, router, href: () => router.state.location.href };
}

type AppRouter = ReturnType<typeof createAppRouter>;

/** Resolves once the router has settled on another address than `from` (the test times out otherwise). */
function leaving(router: AppRouter, from: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = router.subscribe('onResolved', () => {
      if (router.state.location.href === from) return;
      stop();
      resolve();
    });
  });
}

describe('AC-15: route guards in the router', () => {
  it('sends a signed-out user to /login with the whole address as `next`', async () => {
    const { href } = await open('/team/ENG?tab=1', client({}));
    expect(href()).toBe('/login?next=%2Fteam%2FENG%3Ftab%3D1');
  });

  it('sends everyone to /setup until setup is complete, and away from it afterwards', async () => {
    expect((await open('/my-issues', client({ setup: false }))).href()).toBe('/setup');
    expect((await open('/login', client({ setup: false }))).href()).toBe('/setup');
    expect((await open('/setup', client({}))).href()).toBe('/login');
  });

  it('after login, the login page sends the user on to a safe `next`', async () => {
    const signedIn = client({ signedInAs: SESSION });
    expect((await open('/login?next=%2Fteam%2FENG', signedIn)).href()).toBe('/team/ENG');
    expect((await open('/login?next=%2F%2Fevil.example', signedIn)).href()).toBe('/my-issues');
  });

  it('opens `/` and `/settings` on their default pages', async () => {
    const signedIn = client({ signedInAs: SESSION });
    expect((await open('/', signedIn)).href()).toBe('/my-issues');
    expect((await open('/settings', signedIn)).href()).toBe('/settings/account/profile');
    expect((await open('/settings/account', signedIn)).href()).toBe('/settings/account/profile');
  });

  it('sends a user whose session ends to /login, back to the page they were on', async () => {
    let ended = false;
    const { app, router, href } = await open(
      '/team/ENG',
      client({ session: () => Promise.resolve(ended ? null : SESSION) }),
    );
    const stop = followAuth(app, router);
    // A revoked or expired session (SPEC-002 E10, E14): the check finds nobody signed in.
    ended = true;
    void app.auth.recheck();
    await leaving(router, '/team/ENG');
    expect(href()).toBe('/login?next=%2Fteam%2FENG');
    stop();
  });

  it('sends a user who logs out to /login without `next`', async () => {
    const { app, router, href } = await open('/team/ENG', client({ signedInAs: SESSION }));
    const stop = followAuth(app, router);
    await app.auth.logout();
    await leaving(router, '/team/ENG');
    expect(href()).toBe('/login');
    stop();
  });

  it('does not reload the routes when auth first loads', async () => {
    const app = new AppModel(new AuthState(client({ signedInAs: SESSION })));
    const router = createAppRouter(app, environment('/my-issues'));
    const invalidate = vi.spyOn(router, 'invalidate');
    const stop = followAuth(app, router);
    await router.load();
    expect(router.state.location.href).toBe('/my-issues');
    expect(invalidate).not.toHaveBeenCalled();
    stop();
  });

  it('shows the error page, not a redirect, when auth cannot be loaded', async () => {
    const down = client({ capabilities: () => Promise.reject(new Error('ECONNREFUSED')) });
    const { app, router, href } = await open('/my-issues', down);
    expect(href()).toBe('/my-issues');
    expect(router.state.matches.map((match) => match.status)).toContain('error');
    // React's server renderer has no error boundaries, so the page is rendered on its own.
    const html = renderToString(
      <AppContext value={app}>
        <AppErrorPage />
      </AppContext>,
    );
    expect(html).toContain('Surface can&#x27;t reach the server');
    expect(html).not.toContain('ECONNREFUSED');
  });

  it('renders a public page without the shell', async () => {
    const { app, router } = await open('/forgot', client({}));
    const html = renderToString(
      <AppContext value={app}>
        <RouterProvider router={router} />
      </AppContext>,
    );
    // A screen session E hasn't registered yet shows the placeholder (features/screens.ts).
    expect(html).toContain('Reset your password isn&#x27;t available yet');
    expect(html).not.toContain('id="sidebar"');
  });
});
