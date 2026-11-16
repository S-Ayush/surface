// SPEC-005 AC-12 (unit part; the axe e2e is held): what the PLAN-005 S8 axe sweep of the shell
// found, kept fixed. Server-rendered markup, as apps/web has no DOM test environment.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { StandaloneNotFoundPage } from '../src/pages/NotFoundPage.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { AvatarMenu } from '../src/shell/AvatarMenu.js';
import { PageHeader } from '../src/shell/PageHeader.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';

class FakeApp extends AppModel {
  constructor() {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
  }

  override userName = () => 'Ada Lovelace';
}

async function render(page: () => ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: page });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(
    <AppContext value={new FakeApp()}>
      <ShellContext value={new ShellStore(null)}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </ShellContext>
    </AppContext>,
  );
}

describe('the avatar menu button', () => {
  it('is named by the avatar inside it, so the initials it shows are part of its name', async () => {
    // axe label-content-name-mismatch (WCAG 2.5.3): a button aria-label hides the visible "AL".
    const html = await render(() => <AvatarMenu />);
    const button = /<button[^>]*aria-haspopup="menu"[^>]*>/.exec(html)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('aria-label');
    expect(html).toContain('role="img" aria-label="Account menu for Ada Lovelace"');
  });
});

describe('the sign-out warning (PLAN-012 S7a)', () => {
  it('is not in the page until Log out finds unsent changes, so the menu stays one tab stop', async () => {
    const html = await render(() => <AvatarMenu />);
    expect(html).not.toContain('role="dialog"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe('the page header', () => {
  it('makes the current page, the last breadcrumb, the page’s one level-one heading', async () => {
    const html = await render(() => (
      <PageHeader crumbs={['Settings', 'Preferences']} title="Preferences" />
    ));
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<li aria-current="page"><h1[^>]*>Preferences<\/h1><\/li>/);
  });
});

describe('the not-found page outside the shell', () => {
  it('has the same level-one heading as the one inside it', async () => {
    const html = await render(() => <StandaloneNotFoundPage />);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
  });
});
