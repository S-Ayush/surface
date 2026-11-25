/**
 * @vitest-environment jsdom
 */
// PLAN-016 S7: the real <Shell> on /settings. The settings nav replaces the app sidebar, "Back to
// app" returns to the page the user came from, and the drawer opens with focus inside it
// (SPEC-005 §6) on settings pages too.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { PageHeader } from '../src/shell/PageHeader.js';
import { Shell } from '../src/shell/Shell.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';

// The features' own dialogs and commands are not what is tested here.
vi.mock('../src/features/hosts.js', () => ({ SHELL_HOSTS: [] }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeApp extends AppModel {
  constructor() {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
  }

  override isAdmin = () => true;
}

const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');

/** `matchMedia` for the drawer query (`max-width: 1023.98px`): matches when `drawer`. */
function setDrawer(drawer: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: drawer,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  host = undefined;
  if (original !== undefined) Object.defineProperty(window, 'matchMedia', original);
});

function Page({ title }: { title: string }) {
  return <PageHeader crumbs={[title]} title={title} />;
}

async function mount(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <Shell>
        <Outlet />
      </Shell>
    ),
  });
  const issues = createRoute({
    getParentRoute: () => rootRoute,
    path: '/team/ENG/issues',
    component: () => <Page title="Issues" />,
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/account/profile',
    component: () => <Page title="Profile" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([issues, settings]),
    history: createMemoryHistory({ initialEntries: [path] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AppContext value={new FakeApp()}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
  return router;
}

const navNamed = (name: string) => document.querySelector(`nav[aria-label="${name}"]`);

describe('the shell on settings pages', () => {
  it('swaps the app sidebar for the settings nav, and Back to app returns to the last app page', async () => {
    setDrawer(false);
    const router = await mount('/team/ENG/issues?x=1');
    expect(navNamed('Sidebar')).not.toBeNull();
    expect(navNamed('Settings')).toBeNull();

    await act(async () => {
      await router.navigate({ to: '/settings/account/profile' });
    });
    expect(navNamed('Settings')).not.toBeNull();
    expect(navNamed('Sidebar')).toBeNull();
    const back = [...document.querySelectorAll('nav[aria-label="Settings"] a')].find(
      (link) => link.textContent === 'Back to app',
    );
    expect(back?.getAttribute('href')).toBe('/team/ENG/issues?x=1');

    // Following it goes there, and the app sidebar is back.
    await act(async () => {
      (back as HTMLAnchorElement).click();
      await Promise.resolve();
    });
    expect(router.state.location.href).toBe('/team/ENG/issues?x=1');
    expect(navNamed('Sidebar')).not.toBeNull();
  });

  it('opens the drawer with focus on its first link, as the app sidebar does', async () => {
    setDrawer(true);
    await mount('/settings/account/profile');
    expect(navNamed('Settings')).toBeNull();
    const open = document.querySelector<HTMLButtonElement>('button[aria-label="Open sidebar"]');
    expect(open).not.toBeNull();
    await act(async () => {
      open?.click();
      await Promise.resolve();
    });
    const nav = navNamed('Settings');
    expect(nav).not.toBeNull();
    expect(document.activeElement).toBe(nav?.querySelector('a'));
    expect(document.activeElement?.textContent).toBe('Back to app');
  });
});
