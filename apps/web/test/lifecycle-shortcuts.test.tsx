/**
 * @vitest-environment jsdom
 */
// PLAN-015 S4 (SPEC-015 §7): `G` `X` opens the route's team archive page (else the home or first
// team) and `#` restores in the `issue` scope (AC-14). The M1 keys stay outside the build until
// PLAN-012 S7b raises it; this slice only implements their handlers. The menu's Go-to and Restore
// commands are `command-menu-lifecycle.test.ts`.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext } from '../src/app/context.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { ArchiveHost } from '../src/features/archive/ArchiveHost.js';
import { SHORTCUTS } from '../src/shortcuts/registry.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';
import { FakeApp, installDomShims, TEAM } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();

const DES = { id: '0192f0c1-7e5a-7b3c-9d4e-0000000000e2', key: 'DES', name: 'Design' };
const teamRow = (id: string, key: string, name: string) => ({
  id,
  key,
  name,
  private: false,
  estimateScale: 'off',
  estimateExtended: false,
  estimateAllowZero: false,
});

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
});

async function mount(path: string): Promise<{ router: AnyRouter; registry: CommandRegistry }> {
  const app = new FakeApp({
    issues: [],
    teams: [teamRow(TEAM, 'ENG', 'Engineering'), teamRow(DES.id, DES.key, DES.name)],
  });
  const holder: { registry?: CommandRegistry } = {};
  function Probe() {
    holder.registry = useCommandRegistry();
    return <ArchiveHost />;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Probe }),
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
      <AppContext value={app}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
  if (holder.registry === undefined) throw new Error('not mounted');
  return { router, registry: holder.registry };
}

describe('G X (nav:team-archive)', () => {
  it("opens the route's team archive page", async () => {
    const { router, registry } = await mount('/team/DES/issues');
    await act(async () => {
      registry.run('nav:team-archive');
      await Promise.resolve();
    });
    expect(router.state.location.pathname).toBe('/team/DES/archive');
  });

  it("opens an issue's team archive from its page", async () => {
    const { router, registry } = await mount('/issue/DES-4/some-title');
    await act(async () => {
      registry.run('nav:team-archive');
      await Promise.resolve();
    });
    expect(router.state.location.pathname).toBe('/team/DES/archive');
  });

  it('without a team in the route, opens the first of the user’s teams (by name: Design)', async () => {
    const { router, registry } = await mount('/my-issues');
    await act(async () => {
      registry.run('nav:team-archive');
      await Promise.resolve();
    });
    expect(router.state.location.pathname).toBe('/team/DES/archive');
  });
});

describe('the keys (§7)', () => {
  it('binds # to issue:restore in the issue scope and G X to nav:team-archive, for M1', () => {
    const restore = SHORTCUTS.find((s) => s.command === 'issue:restore');
    expect(restore).toMatchObject({ keys: ['#'], scope: 'issue', milestone: 'M1' });
    const archive = SHORTCUTS.find((s) => s.command === 'nav:team-archive');
    expect(archive).toMatchObject({ keys: ['G', 'X'], scope: 'global', milestone: 'M1' });
    // No archive, unarchive or purge key.
    expect(SHORTCUTS.some((s) => s.command === 'issue:purge')).toBe(false);
  });
});
