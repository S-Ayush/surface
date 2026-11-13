// SPEC-005 AC-15, third clause (unit part; the e2e is held): a Member opening an admin route sees
// not-found, and the settings nav never shows them admin sections (permissions.md §5).
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
import { SETTINGS, settingsNav, type SettingsSection } from '../src/app/settings.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';

class FakeApp extends AppModel {
  constructor(private readonly role: boolean | undefined) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
  }

  override isAdmin = () => this.role;
}

async function render(section: SettingsSection, admin: boolean | undefined): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <SettingsPage section={section} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(
    <AppContext value={new FakeApp(admin)}>
      <ShellContext value={new ShellStore(null)}>
        <RouterProvider router={router} />
      </ShellContext>
    </AppContext>,
  );
}

const NOT_FOUND = 'This page doesn&#x27;t exist';

describe('AC-15: admin-only settings', () => {
  it('marks exactly Workspace and Members as admin-only', () => {
    const admin = Object.values(SETTINGS).filter((section) => section.admin);
    expect(admin.map((section) => section.title)).toEqual(['Workspace', 'Members']);
  });

  it('shows a Member not-found on an admin section', async () => {
    for (const section of [SETTINGS.members, SETTINGS.workspace]) {
      const html = await render(section, false);
      expect(html).toContain(NOT_FOUND);
      expect(html).not.toContain(`${section.title} isn&#x27;t available yet`);
    }
  });

  it('shows an Admin the section, and waits while the role is unknown', async () => {
    const shown = await render(SETTINGS.members, true);
    expect(shown).toContain('aria-label="Members"');
    expect(shown).not.toContain('Members isn&#x27;t available yet');
    expect(shown).not.toContain(NOT_FOUND);
    const waiting = await render(SETTINGS.members, undefined);
    expect(waiting).toContain('aria-label="Loading"');
    expect(waiting).not.toContain('aria-label="Members"');
    expect(waiting).not.toContain(NOT_FOUND);
  });

  it('never lists admin sections in a Member’s nav', async () => {
    const titles = (admin: boolean | undefined) => settingsNav(admin).map((s) => s.title);
    expect(titles(false)).toEqual(['Profile', 'Preferences', 'Security', 'Labels', 'Teams']);
    expect(titles(undefined)).toEqual(['Profile', 'Preferences', 'Security', 'Labels', 'Teams']);
    expect(titles(true)).toEqual([
      'Profile',
      'Preferences',
      'Security',
      'Workspace',
      'Members',
      'Labels',
      'Teams',
    ]);
    const html = await render(SETTINGS.profile, false);
    expect(html).toContain('>Profile<');
    expect(html).not.toContain('/settings/members');
    expect(html).not.toContain('/settings/workspace');
  });
});
