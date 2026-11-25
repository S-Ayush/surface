/**
 * @vitest-environment jsdom
 */
// PLAN-017 S1 (brand.md §7, B-3): the sidebar header shows the workspace logo when there is one
// and the Surface mark when there is none or it fails to load.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { Sidebar } from '../src/shell/Sidebar.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class LogoApp extends AppModel {
  readonly #logo: string | undefined;
  constructor(logo: string | undefined) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.#logo = logo;
  }
  override workspaceLogoSrc = (): string | undefined => this.#logo;
  override workspaceName = (): string => 'Acme';
}

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

async function mount(logo: string | undefined): Promise<HTMLElement> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Sidebar width={240} autoFocus={false} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    scrollRestoration: false,
  });
  await router.load();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <AppContext value={new LogoApp(logo)}>
        <ShellContext value={new ShellStore(null)}>
          <ShortcutProvider>
            <RouterProvider router={router} />
          </ShortcutProvider>
        </ShellContext>
      </AppContext>,
    );
  });
  return host;
}

const mark = (el: HTMLElement) => el.querySelector('svg[aria-hidden="true"][focusable="false"]');
const logo = (el: HTMLElement) => el.querySelector('img');

describe('the sidebar brand fallback', () => {
  it('falls back to the Surface mark without a workspace logo', async () => {
    const el = await mount(undefined);
    expect(logo(el)).toBeNull();
    expect(mark(el)?.querySelectorAll('path')).toHaveLength(2);
  });

  it('falls back to the Surface mark when the logo fails', async () => {
    const el = await mount('/files/logo.png');
    const img = logo(el);
    expect(img).not.toBeNull();
    expect(mark(el)).toBeNull();
    act(() => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(logo(el)).toBeNull();
    expect(mark(el)).not.toBeNull();
  });

  it('shows the workspace logo instead of the mark', async () => {
    const el = await mount('/files/logo.png');
    expect(logo(el)?.getAttribute('src')).toBe('/files/logo.png');
    expect(mark(el)).toBeNull();
  });
});
