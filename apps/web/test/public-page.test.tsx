/**
 * @vitest-environment jsdom
 */
// PLAN-017 S1 (brand.md §7): the public pages and the setup wizard show the Surface lockup, named
// "Surface", above the screen.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { LoginPage } from '../src/pages/LoginPage.js';
import { PublicPage } from '../src/pages/PublicPage.js';
import { SetupView } from '../src/routes/setup/SetupView.js';
import { EMPTY_VALUES } from '../src/routes/setup/wizard.js';

function lockupIn(html: string): Element | null {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelector('svg[role="img"][aria-label="Surface"]');
}

/** The element inside a memory router, as the app renders it (the pages use router links). */
async function renderInRouter(page: () => React.ReactElement): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

describe('the lockup on public screens', () => {
  it('public pages show the Surface lockup', async () => {
    const html = await renderInRouter(() => (
      <PublicPage screen="login/check-email" title="Check your email" />
    ));
    const svg = lockupIn(html);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('height')).toBe('24');
    expect(svg?.querySelectorAll('path')).toHaveLength(3);
  });

  it('the sign-in page shows the Surface lockup', async () => {
    const unused = () => Promise.reject(new Error('unused'));
    const app = new AppModel(
      new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }),
    );
    const html = await renderInRouter(() => (
      <AppContext value={app}>
        <LoginPage />
      </AppContext>
    ));
    expect(lockupIn(html)).not.toBeNull();
  });

  it('the setup wizard shows the Surface lockup', () => {
    const html = renderToString(
      <SetupView
        screen={{ t: 'checking' }}
        values={EMPTY_VALUES}
        errors={{}}
        formError={undefined}
        submitting={false}
        newLink={undefined}
        onChange={() => undefined}
        onNewLinkChange={() => undefined}
        onSubmit={() => undefined}
        onBack={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(lockupIn(html)).not.toBeNull();
  });
});
