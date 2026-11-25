// PLAN-016 S7: the settings layout. The settings sidebar replaces the app sidebar on /settings/*
// (with "Back to app"), each page is one centred column under its title and description, and the
// global shortcuts stay the registry's (nothing here listens for keys itself). jsdom does not
// compute CSS Modules, so the column sizing is read from the source text.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type AuthClient, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { createAppRouter } from '../src/app/router.js';
import { SETTINGS, settingsNav } from '../src/app/settings.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { inSettings, SettingsSidebar } from '../src/shell/SettingsSidebar.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { SHORTCUTS } from '../src/shortcuts/registry.js';

// The screens are the features' own (their tests cover them); the layout is what is tested here.
vi.mock('../src/features/screens.js', () => ({ SCREENS: {} }));

class FakeApp extends AppModel {
  constructor(private readonly role: boolean | undefined) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
  }

  override isAdmin = () => this.role;
}

async function render(node: () => React.ReactNode, admin: boolean, shell = new ShellStore(null)) {
  const router = createRouter({
    routeTree: createRootRoute({ component: node }),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(
    <AppContext value={new FakeApp(admin)}>
      <ShellContext value={shell}>
        <RouterProvider router={router} />
      </ShellContext>
    </AppContext>,
  );
}

describe('settings pages render in the layout', () => {
  it('shows every section as one column with its title and description', async () => {
    for (const section of Object.values(SETTINGS)) {
      const html = await render(() => <SettingsPage section={section} />, true);
      expect(html, section.title).toMatch(new RegExp(`<h1[^>]*>${section.title}</h1>`));
      expect(html, section.title).toContain(section.description);
      expect(html, section.title).toContain(`aria-label="${section.title}"`);
    }
  });

  it('gives every section a one-line description', () => {
    for (const section of Object.values(SETTINGS)) {
      expect(section.description, section.title).toMatch(/^[^\n]{8,90}\.$/);
    }
  });

  it('resolves every settings URL to a settings route, not not-found', async () => {
    const session: Session = { userId: 'u1', workspaceId: 'w1' };
    const auth: AuthClient = {
      capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
      session: () => Promise.resolve(session),
      login: () => Promise.reject(new Error('unused')),
      logout: () => Promise.resolve(),
    };
    const paths = [
      '/settings/account/profile',
      '/settings/account/preferences',
      '/settings/account/security',
      '/settings/members',
      '/settings/workspace',
      '/settings/labels',
      '/settings/teams',
      '/settings/teams/ENG/general',
      '/settings/teams/ENG/members',
      '/settings/teams/ENG/workflow',
      '/settings/teams/ENG/labels',
      '/settings/teams/ENG/estimates',
      '/settings/teams/ENG/automations',
    ];
    for (const path of paths) {
      const router = createAppRouter(new AppModel(new AuthState(auth)), {
        history: createMemoryHistory({ initialEntries: [path] }),
        origin: 'http://localhost',
        isServer: false,
        scrollRestoration: false,
      });
      await router.load();
      expect(router.state.location.pathname, path).toBe(path);
      expect(inSettings(router.state.location.pathname), path).toBe(true);
      expect(
        router.state.matches.some((match) => match.status === 'notFound'),
        path,
      ).toBe(false);
    }
  });
});

describe('the settings sidebar', () => {
  it('starts with Back to app, then the sections under Account and Workspace', async () => {
    const html = await render(() => <SettingsSidebar width={240} />, true);
    expect(html).toContain('aria-label="Settings"');
    expect(html.indexOf('Back to app')).toBeGreaterThan(-1);
    const order = ['Account', 'Workspace', 'Back to app'].map((text) => html.indexOf(text));
    expect(order[2]).toBeLessThan(order[0] ?? -1);
    for (const item of settingsNav(true)) expect(html).toContain(`href="${item.nav}"`);
  });

  it('leaves admin sections out for a Member', async () => {
    const html = await render(() => <SettingsSidebar width={240} />, false);
    expect(html).not.toContain('/settings/members');
    expect(html).not.toContain('/settings/workspace"');
    expect(html).toContain('/settings/account/profile');
  });

  it('sends Back to app to the last page outside settings, or home', async () => {
    const shell = new ShellStore(null);
    expect(await render(() => <SettingsSidebar width={240} />, true, shell)).toContain('href="/"');
    shell.lastAppPath = '/team/ENG/issues?view=1';
    expect(await render(() => <SettingsSidebar width={240} />, true, shell)).toContain(
      'href="/team/ENG/issues?view=1"',
    );
  });

  it('knows which paths are settings', () => {
    expect(inSettings('/settings')).toBe(true);
    expect(inSettings('/settings/labels')).toBe(true);
    expect(inSettings('/settingsx')).toBe(false);
    expect(inSettings('/team/ENG')).toBe(false);
  });
});

describe('global shortcuts keep working from settings', () => {
  it('registers Esc, Mod+K, [ and the G chords as global, not per page', () => {
    for (const id of ['global.escape', 'global.commandMenu', 'global.sidebar', 'nav.settings']) {
      expect(SHORTCUTS.find((s) => s.id === id)?.scope, id).toBe('global');
    }
  });

  it('adds no ad-hoc key listeners in the settings layout', () => {
    for (const file of ['../src/shell/SettingsSidebar.tsx', '../src/pages/SettingsPage.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/onKeyDown|addEventListener|keydown/);
    }
  });
});

describe('settings column css', () => {
  const css = readFileSync(new URL('../src/pages/Pages.module.css', import.meta.url), 'utf8');

  it('is centred at the settings-column token with no viewport-height assumption', () => {
    expect(css).toMatch(/\.settingsColumn\s*\{[^}]*max-width:\s*var\(--settings-column\)/);
    expect(css).toMatch(/\.settings\s*\{[^}]*justify-content:\s*center/);
    const settingsRules = css.slice(css.indexOf('.settings {'));
    expect(settingsRules).not.toMatch(/100dvh|100vh/);
  });

  it('is a single column below 768px', () => {
    const narrow = /@media \(max-width: 767\.98px\)\s*\{([\s\S]*)\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.settings\s*\{[^}]*padding:\s*var\(--space-16\)/);
  });
});
