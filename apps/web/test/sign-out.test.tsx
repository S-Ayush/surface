/**
 * @vitest-environment jsdom
 */
// PLAN-012 S7a (SPEC-012 §3.12, AC-29, E30): explicit sign-out ends the session, then deletes the
// replica (with or without an open store); unsent changes are warned about first, in the avatar
// menu; **Cancel** keeps the session; a session expiry deletes nothing.
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { SyncStore } from '@surface/sync-client';
import { OverlayProvider, overlayManager } from '@surface/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModel, ReplicaDeleteError } from '../src/app/AppModel.js';
import {
  AuthState,
  UnreachableError,
  type AuthClient,
  type Session,
  type StartMemory,
} from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { retryReplicaDeletes, type ReplicaDeleteMarks } from '../src/app/replica-deletes.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { AvatarMenu } from '../src/shell/AvatarMenu.js';
import { SignOutDialog, unsentChangesMessage } from '../src/shell/SignOutDialog.js';
import { installDomShims } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();

const ADA: Session = { userId: 'u1', workspaceId: 'w1' };
const ADA_REPLICA = 'surface-w1-u1';

/** A flag in memory, as `browserStartMemory` keeps it in `localStorage`. */
function flagMemory(): StartMemory {
  let pending = false;
  return {
    read: () => undefined,
    write: () => undefined,
    clear: () => undefined,
    logoutPending: () => pending,
    setLogoutPending: (on) => {
      pending = on;
    },
  };
}

function marks(): ReplicaDeleteMarks & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    list: () => [...names],
    add: (name) => {
      names.push(name);
    },
    remove: (name) => {
      names.splice(names.indexOf(name), 1);
    },
  };
}

async function signedIn(
  options: {
    client?: Partial<AuthClient>;
    withStore?: boolean;
    deleteReplica?: (name: string) => Promise<void>;
    deletes?: ReplicaDeleteMarks;
  } = {},
) {
  const state: { session: Session | null } = { session: ADA };
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => Promise.resolve(state.session),
    login: () => Promise.resolve({ ok: true }),
    logout: () => {
      state.session = null;
      return Promise.resolve();
    },
    ...options.client,
  };
  const auth = new AuthState(client, { wait: () => Promise.resolve(), memory: flagMemory() });
  await auth.ready();
  const app = new AppModel(auth, {
    ...(options.deleteReplica === undefined ? {} : { deleteReplica: options.deleteReplica }),
    ...(options.deletes === undefined ? {} : { deletes: options.deletes }),
  });
  const store = new SyncStore({
    models: PRODUCTION_MODELS,
    ...ADA,
    locks: null,
    fetch: () => Promise.reject(new Error('not started')),
  });
  if (options.withStore !== false) {
    app.openStore(store, auth.snapshot.status === 'ready' ? auth.snapshot.epoch : -1);
  }
  const destroy = vi.spyOn(store, 'destroy').mockResolvedValue(undefined);
  return { app, auth, store, destroy, state };
}

describe('signing out', () => {
  it('ends the session on the server, then deletes the replica (AC-29)', async () => {
    const order: string[] = [];
    const { app, auth, destroy } = await signedIn({
      client: {
        logout: () => {
          order.push('logout');
          return Promise.resolve();
        },
      },
    });
    destroy.mockImplementation(() => {
      order.push('destroy');
      return Promise.resolve();
    });
    await app.signOut();
    expect(order).toEqual(['logout', 'destroy']);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('keeps the session and the replica when the server refuses the logout', async () => {
    const { app, auth, destroy } = await signedIn({
      client: { logout: () => Promise.reject(new Error('500')) },
    });
    await expect(app.signOut()).rejects.toThrow();
    expect(destroy).not.toHaveBeenCalled();
    expect(auth.snapshot).toMatchObject({ session: ADA });
  });

  it('signs out when the server can’t be reached: the replica goes now, the server session ends later (§3.12 item 2)', async () => {
    let reachable = true;
    const { app, auth, destroy } = await signedIn({
      client: {
        logout: () => Promise.reject(new TypeError('network')),
        session: () => (reachable ? Promise.resolve(ADA) : Promise.reject(new UnreachableError())),
      },
    });
    reachable = false;
    await app.signOut();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('with no store open, deletes by name and decides "unreachable" without a store (minor 5)', async () => {
    let reachable = true;
    const deleted: string[] = [];
    const { app, auth, store, destroy } = await signedIn({
      withStore: false,
      deleteReplica: (name) => {
        deleted.push(name);
        return Promise.resolve();
      },
      client: {
        logout: () => Promise.reject(new TypeError('network')),
        session: () => (reachable ? Promise.resolve(ADA) : Promise.reject(new UnreachableError())),
      },
    });
    expect(app.store).toBeNull();
    reachable = false;
    await app.signOut();
    expect(deleted).toEqual([ADA_REPLICA]);
    expect(destroy).not.toHaveBeenCalled();
    expect(store.status).toBe('idle');
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('after the logout, a replica that can’t be deleted is remembered and retried at the next load (minor 4)', async () => {
    const remembered = marks();
    const { app, auth, destroy } = await signedIn({ deletes: remembered });
    destroy.mockRejectedValue(new Error('IndexedDB closed'));
    await expect(app.signOut()).rejects.toBeInstanceOf(ReplicaDeleteError);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
    expect(remembered.names).toEqual([ADA_REPLICA]);

    const failing = vi.fn(() => Promise.reject(new Error('still blocked')));
    await retryReplicaDeletes(remembered, failing);
    expect(remembered.names).toEqual([ADA_REPLICA]);
    const deleted: string[] = [];
    await retryReplicaDeletes(remembered, (name) => {
      deleted.push(name);
      return Promise.resolve();
    });
    expect(deleted).toEqual([ADA_REPLICA]);
    expect(remembered.names).toEqual([]);
  });

  it('counts the unsent changes of every tab through the store, and 0 without one', async () => {
    const { app, store } = await signedIn();
    vi.spyOn(store, 'countPending').mockResolvedValue(3);
    expect(await app.countUnsent()).toBe(3);
    const none = await signedIn({ withStore: false });
    expect(await none.app.countUnsent()).toBe(0);
  });

  it('a session expiry or revocation deletes nothing (E30, §3.12 item 4)', async () => {
    const { auth, destroy, state } = await signedIn();
    state.session = null; // the server no longer knows the session
    await auth.recheck();
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: false });
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('the unsent-changes dialog (E30)', () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    overlayManager.clear();
  });

  async function show(count: number) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <OverlayProvider>
          <SignOutDialog open count={count} onCancel={onCancel} onConfirm={onConfirm} />
        </OverlayProvider>,
      );
      await Promise.resolve();
    });
    return { onCancel, onConfirm };
  }
  const button = (name: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);

  it('says how many changes are unsent and offers Cancel and Log out', async () => {
    await show(3);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "3 changes haven't been sent yet. Signing out discards them.",
    );
    expect(button('Cancel')).toBeDefined();
    expect(button('Log out')).toBeDefined();
    expect(unsentChangesMessage(1)).toBe("1 change hasn't been sent yet. Signing out discards it.");
  });

  it('is a dialog named "Log out?", so a screen reader announces what it asks', async () => {
    await show(2);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('Log out?');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(dialog?.querySelector('h2')?.id);
  });

  it('Cancel keeps the session: nothing is confirmed', async () => {
    const { onCancel, onConfirm } = await show(2);
    await act(async () => {
      button('Cancel')?.click();
      await Promise.resolve();
    });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Log out confirms', async () => {
    const { onConfirm } = await show(2);
    await act(async () => {
      button('Log out')?.click();
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('Log out in the avatar menu (E30 wiring)', () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    overlayManager.clear();
  });

  class MenuApp extends AppModel {
    readonly signOutCalls: number[] = [];
    constructor(readonly unsent: number) {
      const unused = () => Promise.reject(new Error('unused'));
      super(
        new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }),
      );
    }
    override countUnsent = () => Promise.resolve(this.unsent);
    override signOut = () => {
      this.signOutCalls.push(1);
      return Promise.resolve();
    };
  }

  async function mount(app: AppModel): Promise<void> {
    const rootRoute = createRootRoute({ component: AvatarMenu });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
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
          <OverlayProvider>
            <ShortcutProvider>
              <RouterProvider router={router} />
            </ShortcutProvider>
          </OverlayProvider>
        </AppContext>,
      );
      await Promise.resolve();
    });
  }

  async function chooseLogOut(): Promise<void> {
    const trigger = host?.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    await act(async () => {
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent.startsWith('Log out'),
    );
    expect(item).toBeDefined();
    await act(async () => {
      item?.click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  const dialog = () => document.querySelector('[role="dialog"]');

  it('with unsent changes, asks first and signs out only on Log out', async () => {
    const app = new MenuApp(2);
    await mount(app);
    await chooseLogOut();
    expect(dialog()?.textContent).toContain("2 changes haven't been sent yet");
    expect(app.signOutCalls).toEqual([]);
    const confirm = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Log out',
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(app.signOutCalls).toEqual([1]);
  });

  it('Cancel never signs out', async () => {
    const app = new MenuApp(2);
    await mount(app);
    await chooseLogOut();
    const cancel = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Cancel',
    );
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(app.signOutCalls).toEqual([]);
  });

  it('with nothing unsent, signs out at once and shows no dialog', async () => {
    const app = new MenuApp(0);
    await mount(app);
    await chooseLogOut();
    expect(dialog()).toBeNull();
    expect(app.signOutCalls).toEqual([1]);
  });
});
