// E's PLAN-001 S6 handoff: the shell shows the user's avatar (avatar menu) and the workspace logo
// (sidebar header, SPEC-005 §7 "[Logo] Workspace name"), served from /files/:id (ADR-0014).
// Server-rendered markup, as apps/web has no DOM test environment. The real avatar's <img> appears
// only once a browser has loaded it (the initials until then), so `Avatar` is replaced by a stand-in
// that shows the `src` it was given.
import { User, Workspace } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import type * as Ui from '@surface/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { AvatarMenu } from '../src/shell/AvatarMenu.js';
import { Sidebar } from '../src/shell/Sidebar.js';

vi.mock('@surface/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  Avatar: ({ name, src }: { name: string; src?: string }) => (
    <span data-avatar={name} data-src={src ?? 'none'} />
  ),
}));

const ME = '01930000-0000-7000-8000-00000000ada1';
const AVATAR = '01930000-0000-7000-8000-0000000000a1';
const LOGO = '01930000-0000-7000-8000-0000000000b1';

/** Only the rows the shell's header reads; the real store is sync-client's to test. */
class FakeApp extends AppModel {
  readonly #store: SyncStore;
  constructor(user: object | undefined, workspace: object | undefined, connection = 'online') {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.#store = {
      status: 'ready',
      connection,
      pool: {
        get: (model: unknown, id: string) => (model === User && id === ME ? user : undefined),
        all: (model: unknown) => (model === Workspace && workspace ? [workspace] : []),
      },
    } as unknown as SyncStore;
  }
  override get store(): SyncStore | null {
    return this.#store;
  }
  override get session(): Session {
    return { userId: ME, workspaceId: 'w-1' };
  }
}

const ada = { id: ME, name: 'Ada Lovelace', avatarFileId: AVATAR };
const acme = { id: 'w-1', name: 'Acme', logoFileId: LOGO };

async function render(app: AppModel, page: () => React.ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(
    <AppContext value={app}>
      <ShellContext value={new ShellStore(null)}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </ShellContext>
    </AppContext>,
  );
}

describe('the shell’s avatar and logo', () => {
  it('reads the user’s avatar and the workspace’s logo as file URLs', () => {
    const app = new FakeApp(ada, acme);
    expect(app.userAvatarSrc()).toBe(`/files/${AVATAR}`);
    expect(app.workspaceLogoSrc()).toBe(`/files/${LOGO}`);
  });

  it('has none for a user or workspace without one', () => {
    const app = new FakeApp({ ...ada, avatarFileId: null }, { ...acme, logoFileId: null });
    expect(app.userAvatarSrc()).toBeUndefined();
    expect(app.workspaceLogoSrc()).toBeUndefined();
    expect(new FakeApp(undefined, undefined).workspaceLogoSrc()).toBeUndefined();
    expect(new FakeApp(undefined, undefined).userAvatarSrc()).toBeUndefined();
  });

  it('gives the avatar menu the user’s avatar', async () => {
    const html = await render(new FakeApp(ada, acme), () => <AvatarMenu />);
    expect(html).toContain(`data-avatar="Ada Lovelace" data-src="/files/${AVATAR}"`);
  });

  it('knows when the replica is connected, so an image that failed offline loads again', () => {
    // The shell remounts the avatar and logo when this changes: neither retries a failed URL itself.
    expect(new FakeApp(ada, acme, 'online').online()).toBe(true);
    for (const connection of ['connecting', 'offline', 'revoked', 'disconnected']) {
      expect(new FakeApp(ada, acme, connection).online(), connection).toBe(false);
    }
  });

  it('shows the logo before the workspace name, as decoration (the name says it)', async () => {
    const html = await render(new FakeApp(ada, acme), () => (
      <Sidebar width={240} autoFocus={false} />
    ));
    const logo = new RegExp(`<img[^>]*src="/files/${LOGO}"[^>]*>`).exec(html)?.[0];
    expect(logo).toBeDefined();
    expect(logo).toContain('alt=""');
    expect(html.indexOf(`/files/${LOGO}`)).toBeLessThan(html.indexOf('>Acme<'));
  });

  it('shows no logo for a workspace without one', async () => {
    const html = await render(new FakeApp(ada, { ...acme, logoFileId: null }), () => (
      <Sidebar width={240} autoFocus={false} />
    ));
    expect(html).toContain('>Acme<');
    expect(html).not.toContain('<img');
  });
});
