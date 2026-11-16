/**
 * @vitest-environment jsdom
 */
// PLAN-012 S7a (SPEC-012 §3.12, AC-29, E30): explicit sign-out ends the session, then deletes the
// replica; unsent changes are warned about first; **Cancel** keeps the session; a session expiry
// deletes nothing.
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { SyncStore } from '@surface/sync-client';
import { OverlayProvider, overlayManager } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, UnreachableError, type AuthClient, type Session } from '../src/app/auth.js';
import { SignOutDialog, unsentChangesMessage } from '../src/shell/SignOutDialog.js';
import { installDomShims } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();

const ADA: Session = { userId: 'u1', workspaceId: 'w1' };

async function signedIn(overrides: Partial<AuthClient> = {}) {
  const state: { session: Session | null } = { session: ADA };
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => Promise.resolve(state.session),
    login: () => Promise.resolve({ ok: true }),
    logout: () => {
      state.session = null;
      return Promise.resolve();
    },
    ...overrides,
  };
  const auth = new AuthState(client, { wait: () => Promise.resolve() });
  await auth.ready();
  const app = new AppModel(auth);
  const store = new SyncStore({
    models: PRODUCTION_MODELS,
    ...ADA,
    locks: null,
    fetch: () => Promise.reject(new Error('not started')),
  });
  const epoch = auth.snapshot.status === 'ready' ? auth.snapshot.epoch : -1;
  app.openStore(store, epoch);
  const destroy = vi.spyOn(store, 'destroy').mockResolvedValue(undefined);
  return { app, auth, store, destroy, state };
}

describe('signing out', () => {
  it('ends the session on the server, then deletes the replica (AC-29)', async () => {
    const order: string[] = [];
    const { app, auth, destroy } = await signedIn({
      logout: () => {
        order.push('logout');
        return Promise.resolve();
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

  it('keeps the replica when the server refuses the logout', async () => {
    const { app, auth, store, destroy } = await signedIn({
      logout: () => Promise.reject(new Error('500')),
    });
    vi.spyOn(store, 'connection', 'get').mockReturnValue('online');
    await expect(app.signOut()).rejects.toThrow();
    expect(destroy).not.toHaveBeenCalled();
    expect(auth.snapshot).toMatchObject({ session: ADA });
  });

  let down = false;
  it('signs out offline too: the replica goes and the server session ends later (§3.12 item 2)', async () => {
    const { app, auth, store, destroy } = await signedIn({
      logout: () => Promise.reject(new TypeError('network')),
      session: () => (down ? Promise.reject(new UnreachableError()) : Promise.resolve(ADA)),
    });
    down = true;
    vi.spyOn(store, 'connection', 'get').mockReturnValue('offline');
    await app.signOut();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('counts the changes the server has not confirmed', async () => {
    const { app, store } = await signedIn();
    expect(app.unsentChanges()).toBe(0);
    vi.spyOn(store, 'pending', 'get').mockReturnValue(new Array(3) as never);
    expect(app.unsentChanges()).toBe(3);
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
